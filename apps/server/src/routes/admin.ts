import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import { auditRepo } from '../repositories/audit.js';

export const adminRouter = Router();

// ---------- Firm settings ----------

adminRouter.get(
  '/settings',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const row = await db('firm_settings').where({ id: 1 }).first();
    res.json({ settings: row });
  }),
);

const settingsSchema = z.object({
  firmName: z.string().min(1).max(255).optional(),
  logoUrl: z.string().max(1024).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  stepupTimeoutHours: z
    .union([z.literal(4), z.literal(8), z.literal(24), z.literal(168), z.literal(-1)])
    .optional(),
  emailOutboundMode: z.enum(['summary', 'content']).optional(),
  emailOutboundContentPreviewChars: z.number().int().min(0).max(2000).optional(),
  smsProvider: z.enum(['textlink', 'twilio', 'mock']).optional(),
  smsMonthlyCap: z.number().int().min(0).max(100_000).optional(),
  exportExternalRequiresRecoveryPhrase: z.boolean().optional(),
  sidebarGroupsOrder: z.array(z.string().uuid()).optional(),
});

adminRouter.patch(
  '/settings',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const patch: Record<string, unknown> = {};
    if (parsed.data.firmName !== undefined) patch.firm_name = parsed.data.firmName;
    if (parsed.data.logoUrl !== undefined) patch.logo_url = parsed.data.logoUrl;
    if (parsed.data.retentionDays !== undefined) patch.retention_days = parsed.data.retentionDays;
    if (parsed.data.stepupTimeoutHours !== undefined)
      patch.stepup_timeout_hours = parsed.data.stepupTimeoutHours;
    if (parsed.data.emailOutboundMode !== undefined)
      patch.email_outbound_mode = parsed.data.emailOutboundMode;
    if (parsed.data.emailOutboundContentPreviewChars !== undefined)
      patch.email_outbound_content_preview_chars = parsed.data.emailOutboundContentPreviewChars;
    if (parsed.data.smsProvider !== undefined) patch.sms_provider = parsed.data.smsProvider;
    if (parsed.data.smsMonthlyCap !== undefined) patch.sms_monthly_cap = parsed.data.smsMonthlyCap;
    if (parsed.data.exportExternalRequiresRecoveryPhrase !== undefined)
      patch.export_external_requires_recovery_phrase =
        parsed.data.exportExternalRequiresRecoveryPhrase;
    if (parsed.data.sidebarGroupsOrder !== undefined)
      patch.sidebar_groups_order = JSON.stringify(parsed.data.sidebarGroupsOrder);
    if (Object.keys(patch).length > 0) {
      await db('firm_settings')
        .where({ id: 1 })
        .update({ ...patch, updated_at: db.fn.now() });
    }
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.settings_updated',
      targetType: 'firm_settings',
      details: parsed.data,
    });
    res.json({ ok: true });
  }),
);

// ---------- Audit log ----------

adminRouter.get(
  '/audit',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const rows = await db('audit_log').orderBy('created_at', 'desc').limit(limit).offset(offset);
    res.json({
      rows: rows.map((r) => ({
        id: r.id,
        actorUserId: r.actor_user_id,
        actorExternalIdentityId: r.actor_external_identity_id,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        details: r.details,
        ipAddress: r.ip_address,
        createdAt: r.created_at,
      })),
    });
  }),
);

// ---------- Device health ----------

const CURRENT_VERSION = '0.1.0';
const KNOWN_VERSIONS = new Set(['0.1.0', '0.1.0-pre-phase3']);
const DRIFT_DAYS = 14;
const STALE_DAYS = 7;

adminRouter.get(
  '/devices',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await db('user_keys as uk')
      .leftJoin('users as u', 'u.id', 'uk.user_id')
      .select(
        'uk.id',
        'uk.user_id as userId',
        'uk.device_id as deviceId',
        'uk.public_key as publicKey',
        'uk.key_version as keyVersion',
        'uk.client_platform as clientPlatform',
        'uk.client_version as clientVersion',
        'uk.last_heartbeat_at as lastHeartbeatAt',
        'uk.created_at as createdAt',
        'uk.revoked_at as revokedAt',
        'u.display_name as displayName',
        'u.username as username',
      );
    const now = Date.now();
    const enriched = rows.map((r) => {
      let flag: 'healthy' | 'update_drift' | 'stale' | 'unknown_version' = 'healthy';
      let explanation = 'Up to date and recently active.';
      let remediation = '';
      if (r.clientVersion && !KNOWN_VERSIONS.has(r.clientVersion)) {
        flag = 'unknown_version';
        explanation = `Client version ${r.clientVersion} not recognized by the server.`;
        remediation =
          'Ask the user to force-quit and relaunch. If it persists, revoke this device.';
      } else if (
        r.lastHeartbeatAt &&
        now - new Date(r.lastHeartbeatAt as string).getTime() > STALE_DAYS * 86_400_000
      ) {
        flag = 'stale';
        explanation = `No heartbeat for over ${STALE_DAYS} days.`;
        remediation =
          'Ask the user to open the app and sign in; if not reachable, revoke this device.';
      } else if (
        r.clientVersion &&
        r.clientVersion !== CURRENT_VERSION &&
        // older than DRIFT_DAYS (we can't compare versions strictly without semver; use heartbeat age)
        r.lastHeartbeatAt &&
        now - new Date(r.lastHeartbeatAt as string).getTime() > DRIFT_DAYS * 86_400_000
      ) {
        flag = 'update_drift';
        explanation = `Running ${r.clientVersion}; current is ${CURRENT_VERSION}.`;
        remediation = 'Open Vibe Connect to trigger the updater, or have IT reinstall.';
      }
      return { ...r, flag, flagExplanation: explanation, remediation };
    });
    res.json({ devices: enriched });
  }),
);

adminRouter.post(
  '/devices/:id/revoke',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db('user_keys').where({ id: req.params.id! }).update({ revoked_at: db.fn.now() });
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.device_revoked',
      targetType: 'user_key',
      targetId: req.params.id!,
    });
    res.json({ ok: true });
  }),
);

adminRouter.post(
  '/devices/heartbeat',
  asyncHandler(async (req, res) => {
    // Open endpoint for clients; requires session to identify the user, but not admin.
    if (!req.session.userId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body = z
      .object({
        deviceId: z.string().min(1).max(128),
        clientPlatform: z.enum(['tauri-win', 'tauri-mac', 'tauri-linux', 'pwa', 'web']),
        clientVersion: z.string().min(1).max(64),
      })
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    await db('user_keys')
      .where({ user_id: req.session.userId, device_id: body.data.deviceId })
      .update({
        last_heartbeat_at: db.fn.now(),
        client_platform: body.data.clientPlatform,
        client_version: body.data.clientVersion,
      });
    res.json({ ok: true });
  }),
);

// ---------- Per-conversation export ----------

const exportSchema = z.object({
  conversationId: z.string().uuid(),
  recoveryPhrase: z.array(z.string()).optional(),
  includeTeamNotes: z.boolean().default(false),
});

adminRouter.post(
  '/export',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = exportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const conv = await db('conversations').where({ id: parsed.data.conversationId }).first();
    if (!conv) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const settings = await db('firm_settings').where({ id: 1 }).first();
    if (
      conv.type === 'external' &&
      settings?.export_external_requires_recovery_phrase &&
      !(parsed.data.recoveryPhrase && parsed.data.recoveryPhrase.length === 24)
    ) {
      res.status(400).json({ error: 'recovery_phrase_required' });
      return;
    }
    // Return the raw ciphertext bundle; decryption happens on the admin's client with the
    // recovery phrase (to keep plaintext off the server).
    const messages = await db('messages')
      .where({ conversation_id: conv.id })
      .whereNull('deleted_at')
      .orderBy('created_at', 'asc');
    const keys = await db('conversation_keys')
      .where({ conversation_id: conv.id })
      .orderBy('rotation_version', 'asc');
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.conversation_exported',
      targetType: 'conversation',
      targetId: conv.id,
      details: {
        includeTeamNotes: parsed.data.includeTeamNotes,
        usedRecoveryPhrase: Boolean(parsed.data.recoveryPhrase),
      },
    });
    res.json({
      conversation: {
        id: conv.id,
        type: conv.type,
        displayName: conv.display_name,
        createdAt: conv.created_at,
      },
      messages: messages.map((m) => ({
        id: m.id,
        senderId: m.sender_id,
        senderExternalIdentityId: m.sender_external_identity_id,
        ciphertext: (m.ciphertext as Buffer).toString('base64'),
        contentKeyVersion: m.content_key_version,
        urgent: m.urgent,
        source: m.source,
        createdAt: m.created_at,
        editedAt: m.edited_at,
        ciphertextMeta: m.ciphertext_meta,
      })),
      conversationKeys: keys.map((k) => ({
        rotationVersion: k.rotation_version,
        wrappedKeys: k.wrapped_keys,
      })),
    });
  }),
);

// ---------- Bulk user CSV import ----------

const importSchema = z.object({
  users: z.array(
    z.object({
      username: z.string().min(2).max(64),
      email: z.string().email().optional(),
      displayName: z.string().min(1).max(128),
      initialPassword: z.string().min(12).max(512),
      isAdmin: z.boolean().optional(),
      groupIds: z.array(z.string().uuid()).optional(),
    }),
  ),
});

adminRouter.post(
  '/users/bulk',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const bcrypt = (await import('bcryptjs')).default;
    const created: string[] = [];
    const skipped: Array<{ username: string; reason: string }> = [];
    for (const u of parsed.data.users) {
      const existing = await db('users').where({ username: u.username }).first();
      if (existing) {
        skipped.push({ username: u.username, reason: 'already_exists' });
        continue;
      }
      const hash = await bcrypt.hash(u.initialPassword, 12);
      const [row] = await db('users')
        .insert({
          username: u.username,
          email: u.email ?? null,
          display_name: u.displayName,
          password_hash: hash,
          is_admin: u.isAdmin ?? false,
        })
        .returning(['id']);
      created.push(row!.id);
      for (const gid of u.groupIds ?? []) {
        await db('user_groups').insert({ user_id: row!.id, group_id: gid }).onConflict().ignore();
      }
    }
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.bulk_import',
      targetType: 'user',
      details: { created: created.length, skipped: skipped.length },
    });
    res.json({ created, skipped });
  }),
);

// ---------- SMS audit + cap status (Phase 25) ----------

adminRouter.get(
  '/sms/audit',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await db('audit_log')
      .whereIn('action', ['sms.opt_in', 'sms.opt_out', 'sms.sent', 'sms.inbound_stored'])
      .orderBy('created_at', 'desc')
      .limit(500);
    res.json({ rows });
  }),
);

adminRouter.get(
  '/sms/status',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const settings = await db('firm_settings').where({ id: 1 }).first();
    const cap = Number(settings?.sms_monthly_cap ?? 1000);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const sent = await db('audit_log')
      .where({ action: 'sms.sent' })
      .andWhere('created_at', '>=', monthStart)
      .count<{ count: string }[]>('* as count');
    const count = Number(sent[0]!.count);
    res.json({
      provider: settings?.sms_provider ?? 'mock',
      monthlyCap: cap,
      monthSent: count,
      percent: cap === 0 ? 0 : Math.round((count / cap) * 100),
      capAlerts: {
        eighty: cap > 0 && count / cap >= 0.8,
        hundred: cap > 0 && count >= cap,
      },
    });
  }),
);

adminRouter.get(
  '/sms/opt-ins',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await db('sms_opt_ins as s')
      .leftJoin('external_identities as e', 'e.id', 's.external_identity_id')
      .select(
        's.external_identity_id as externalIdentityId',
        's.opted_in_at as optedInAt',
        's.opted_out_at as optedOutAt',
        's.last_stop_keyword_at as lastStopKeywordAt',
        's.provider',
        's.source',
        'e.display_name as displayName',
        'e.phone',
      )
      .orderBy('s.opted_in_at', 'desc');
    res.json({ rows });
  }),
);

// ---------- Firm public key (read-only) ----------

export const firmRouter = Router();
firmRouter.get(
  '/public-key',
  asyncHandler(async (_req, res) => {
    const row = await db('firm_keys').whereNull('retired_at').first();
    if (!row) {
      res.status(404).json({ error: 'not_installed' });
      return;
    }
    res.json({ publicKey: row.public_key, rotationVersion: row.rotation_version });
  }),
);
