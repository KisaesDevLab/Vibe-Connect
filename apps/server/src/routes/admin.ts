import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Knex } from 'knex';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { effectiveUrls } from '../services/effectiveUrls.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { auditRepo } from '../repositories/audit.js';
import { generateInviteMaterial, sendClientInvite } from '../services/clientInvite.js';
import { normalizePhone } from '../services/accessCodes.js';
import { tlsRouter } from './tls.js';
import {
  clear as clearProviderSecret,
  isKnownKey as isKnownProviderSecretKey,
  metaList as listProviderSecrets,
  PROVIDER_SECRET_KEYS,
  set as setProviderSecret,
  type ProviderSecretKey,
} from '../services/providerSecrets.js';
import { runRetentionSweep } from '../services/retention.js';
import { terminateSessionsForUser } from '../services/sessions.js';

export const adminRouter = Router();

// TLS / Let's Encrypt endpoints live in their own file (routes/tls.ts)
// so this router stays scannable. Mounted as a subrouter, not under a
// /tls prefix — each route inside already namespaces itself with /tls/*.
adminRouter.use('/', tlsRouter);

/** Parse an ISO-8601 date query param; return null if missing or invalid. */
function parseIsoDate(v: unknown): Date | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** SHA-256 of a PII value, base64'd. Used so the audit row records that *some*
 *  email was forgotten without preserving the original — sufficient for later
 *  correlation if the same address is ever presented again, not reversible. */
function hashForAudit(value: string): string {
  return createHash('sha256').update(value).digest('base64');
}

/**
 * Allowlist of details-keys that may leave the audit boundary via CSV export.
 * An operator exporting the audit log might share the file for compliance,
 * so we keep the keys that describe *what happened* (action metadata,
 * counts, device IDs for revocation reconciliation) and drop anything that
 * leaks *content* (usernames, message bodies, last-seen IPs of specific
 * users, etc.). Unknown keys are redacted to [omitted]; action-specific
 * entries below override the default where the detail is genuinely useful.
 */
const AUDIT_DETAIL_EXPORT_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  'attachment.infected_rejected': new Set(['signature']),
  'attachment.scan_unavailable': new Set(['blobDeleted', 'rowDeleted']),
  'portal.attachment_infected_rejected': new Set(['signature', 'mimeType']),
  'portal.attachment_scan_unavailable': new Set(['blobDeleted', 'rowDeleted', 'mimeType']),
  'portal.attachment_uploaded': new Set(['mimeType', 'size']),
  'admin.device_revoked': new Set(['sessionsTerminated', 'wrappedKeysStripped']),
  'admin.user_password_reset': new Set(['sessionsTerminated']),
  'admin.user_password_reset_rejected': new Set(['reason']),
  'admin.provider_secret_updated': new Set(['last4', 'fingerprint', 'masked']),
  'admin.provider_secret_cleared': new Set([]),
  'portal.stepup_identity_locked': new Set(['lockoutsInDay']),
  'portal.verify_identity_locked': new Set(['attemptsInHour']),
  'portal.session_ua_drift_revoked': new Set(['fromFamily', 'toFamily']),
  'admin.audit_export': new Set(['rowCount', 'format']),
};

function redactAuditDetailsForExport(action: unknown, details: unknown): unknown {
  if (!details || typeof details !== 'object') return details;
  const allow = typeof action === 'string' ? AUDIT_DETAIL_EXPORT_ALLOWLIST[action] : undefined;
  // Unknown action → redact entirely so a future code path that writes
  // sensitive detail doesn't leak by default. An explicit opt-in entry in
  // the allowlist above is the only way to surface a given key.
  if (!allow) return { redacted: true };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    out[k] = allow.has(k) ? v : '[omitted]';
  }
  return out;
}

// ---------- Firm settings ----------

adminRouter.get(
  '/settings',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const row = await db('firm_settings').where({ id: 1 }).first();
    // Surface env-derived URL defaults alongside the row so the admin UI
    // can show "currently overriding to X, env default is Y" without a
    // second roundtrip. Source: services/effectiveUrls.ts.
    const urls = await effectiveUrls();
    res.json({
      settings: row,
      envSiteUrl: urls.envSiteUrl,
      envPortalUrl: urls.envPortalUrl,
      effectiveSiteUrl: urls.siteUrl,
      effectivePortalUrl: urls.portalUrl,
      // Same "currently overriding X, env default is Y" treatment for the
      // sender address so the Admin → Providers UI can render the env
      // fallback as a placeholder when the DB column is null. Pre-this
      // setting, EMAIL_FROM was env-only and a misconfigured placeholder
      // caused silent 422s at every real provider — the whole reason this
      // column exists is so an operator can fix it from the UI.
      envEmailFrom: env.emailFrom,
    });
  }),
);

const settingsSchema = z.object({
  firmName: z.string().min(1).max(255).optional(),
  // Display name for the staff app chrome (header label + browser tab title).
  // Empty string clears it back to the default "Vibe Connect" branding.
  appName: z.string().max(80).nullable().optional(),
  // Must be a real http/https URL so an admin can't inject `javascript:` /
  // `data:` / relative paths that downstream <img src={logoUrl}> renders would
  // treat as same-origin scripts. Empty string is coerced to null upstream.
  logoUrl: z
    .string()
    .max(1024)
    .url()
    .refine((u) => /^https?:\/\//i.test(u), {
      message: 'logoUrl must be http(s)',
    })
    .nullable()
    .optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  stepupTimeoutHours: z
    .union([z.literal(4), z.literal(8), z.literal(24), z.literal(168), z.literal(-1)])
    .optional(),
  emailOutboundMode: z.enum(['summary', 'content']).optional(),
  emailOutboundContentPreviewChars: z.number().int().min(0).max(2000).optional(),
  smsProvider: z.enum(['textlink', 'twilio', 'mock']).optional(),
  smsMonthlyCap: z.number().int().min(0).max(100_000).optional(),
  emailProvider: z.enum(['mock', 'postmark', 'postfix', 'emailit']).optional(),
  // RFC 5322 sender address. Either a bare `user@host` or the friendly
  // form `Display Name <user@host>` (which is what env.emailFrom
  // defaults to). Full RFC 5322 grammar is too permissive to validate
  // usefully with regex — we settle for: trimmed, ≤254 chars (RFC 5321
  // path limit), must contain `@`. Null clears the override so
  // env.emailFrom takes effect again. Provider boundary
  // (bridges/email/index.ts resolveEmailFrom) does the final
  // placeholder-rejection and is also wired into the validator below
  // so an admin can't save the bundled placeholder.
  emailFrom: z.string().max(254).nullable().optional(),
  exportExternalRequiresRecoveryPhrase: z.boolean().optional(),
  sidebarGroupsOrder: z.array(z.string().uuid()).optional(),
  // 0 = never lock; upper bound matches the DB constraint (24 h).
  idleLockMinutes: z.number().int().min(0).max(1440).optional(),
  // Kill switch for portal + bridges. Internal staff messaging stays on either way.
  clientMessagingEnabled: z.boolean().optional(),

  // Phase 24 follow-up: kill switch for the Client Requests & Document
  // Collection feature. Existing lists stay readable for audit; new
  // creates / submissions / nudges refuse with 403 when disabled.
  requestsEnabled: z.boolean().optional(),

  // Message edit window in minutes. 0 disables edits entirely. Upper bound
  // caps accidental misconfig — no legitimate workflow needs > 24h edits.
  messageEditWindowMinutes: z.number().int().min(0).max(1440).optional(),

  // Phase 27 — message timed self-destruct.
  // `enabled` is a hard kill switch (compose dropdown hidden + send route
  // refuses the field). `maxSeconds` caps the dropdown so a staffer can't
  // pick "destruct in 100 years" by accident. Floor of 60s blocks degenerate
  // values; ceiling of 30 days keeps the feature meaningfully ephemeral.
  messageDestructEnabled: z.boolean().optional(),
  messageDestructMaxSeconds: z.number().int().min(60).max(2_592_000).optional(),

  // SMS quiet-hours window. Hours are 0-23 in the recipient's local time.
  // For cross-midnight windows set start > end (e.g. quietStart=22, quietEnd=6
  // means quiet 22:00-06:00). TCPA default is 08..21; admins may tighten.
  smsQuietStartHour: z.number().int().min(0).max(23).optional(),
  smsQuietEndHour: z.number().int().min(0).max(23).optional(),

  // Phase 24.7 — request auto-nudge config. Off by default (firm migration
  // 20260425000002 default-false). Offsets are positive integers ≤ 8760
  // hours (one year before due) so a typo can't queue years of nudges.
  // Min 1 offset so a saved-empty-array doesn't silently disable the
  // sweeper while leaving auto_nudge_enabled = true.
  autoNudgeEnabled: z.boolean().optional(),
  autoNudgeOffsetsHours: z.array(z.number().int().min(0).max(8760)).min(1).max(10).optional(),

  // TLS / Let's Encrypt — domains, ACME contact, environment. Phase 1 only
  // accepts 'http-01' for the challenge type; Phase 2 widens this.
  // Domain regex: RFC 1123 hostname shape, up to 253 chars, at least one dot.
  tlsStaffDomain: z
    .string()
    .max(253)
    .regex(/^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/)
    .nullable()
    .optional(),
  tlsPortalDomain: z
    .string()
    .max(253)
    .regex(/^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/)
    .nullable()
    .optional(),
  tlsAcmeEmail: z.string().email().max(254).nullable().optional(),
  tlsAcmeEnvironment: z.enum(['staging', 'production']).optional(),
  tlsChallengeType: z.enum(['http-01']).optional(),

  // Phase 26 — Client Vault firm settings.
  vaultEnabled: z.boolean().optional(),
  vaultClientDelete: z.boolean().optional(),
  vaultMaxFileBytes: z
    .number()
    .int()
    .min(1024 * 1024)
    .max(5_368_709_120) // 5 GiB ceiling — bigger than any realistic vault upload
    .optional(),
  vaultRetentionSharedDays: z.number().int().min(0).max(36500).optional(),
  vaultRetentionStaffDays: z.number().int().min(0).max(36500).optional(),
  vaultFolderTemplates: z
    .array(
      z.object({
        nameTemplate: z.string().min(1).max(255),
        zone: z.enum(['shared', 'staff_only']),
        retentionDays: z.number().int().min(1).max(36500).nullable().optional(),
      }),
    )
    .max(64)
    .optional(),
  vaultNewYearCronEnabled: z.boolean().optional(),
  vaultInformationBarrier: z.boolean().optional(),

  // Admin overrides for SITE_URL / PORTAL_URL. Null clears the override so
  // env values take effect again. Validation is strict: must parse as a
  // URL, http or https only, no query/fragment, no trailing slash. We
  // explicitly REJECT the dev-default placeholder ("http://localhost:4000")
  // so a confused admin can't "save" the same wrong value they're trying
  // to fix and walk away thinking it's now set. Plain localhost over
  // http is allowed for dev/staging; anything else must be https.
  siteUrl: z.string().nullable().optional(),
  portalUrl: z.string().nullable().optional(),
});

/**
 * Validate one of the admin-settable URL overrides. Returns the normalized
 * value (trimmed, no trailing slash) on success, or an error message tag.
 * Pulled into a helper so siteUrl + portalUrl share semantics — drifting
 * validation between the two would let an admin save a malformed siteUrl
 * after the portalUrl one rejected it.
 *
 * Returns null when the input is null or empty (the "clear override" path).
 */
function normalizeAdminUrl(
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > 1024) return { ok: false, error: 'too_long' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'bad_scheme' };
  }
  if (parsed.search) return { ok: false, error: 'query_not_allowed' };
  if (parsed.hash) return { ok: false, error: 'fragment_not_allowed' };
  // localhost / 127.0.0.1 / loopback IPv6 may use plain http; anything else
  // demands https. Stops an admin from saving a real public URL over http,
  // which would land cookies on a non-secure origin and break session
  // handling.
  const isLoopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname === '::1';
  if (parsed.protocol === 'http:' && !isLoopback) {
    return { ok: false, error: 'http_only_allowed_for_localhost' };
  }
  // Refuse the canonical dev defaults — saving them is almost always a
  // misclick by an admin trying to fix a misconfigured appliance.
  const normalized = trimmed.replace(/\/$/, '');
  if (normalized === 'http://localhost:4000' || normalized === 'http://localhost:4000/portal') {
    return { ok: false, error: 'dev_default_not_allowed' };
  }
  return { ok: true, value: normalized };
}

// Minimum set of provider-secret keys that must be configured before switching
// an outbound channel to a given provider. If any are missing, the PATCH is
// refused with a clear error so the admin doesn't flip the switch and then
// discover every outbound notification failing at send time.
const REQUIRED_SECRETS_BY_PROVIDER: Record<string, ProviderSecretKey[]> = {
  postmark: ['email.postmark.server_token'],
  // SMTP: only HOST is truly required. PORT has an env default (587),
  // user / pass are optional (some relays accept unauthenticated), and
  // the `secure` flag defaults to STARTTLS. The pre-flight check is
  // meant to catch "obviously broken" configs that would 100% fail at
  // send time — partial / nuanced misconfigs (e.g. user without pass)
  // are caught with friendlier errors at the actual send call.
  postfix: ['email.smtp.host'],
  emailit: ['email.emailit.api_key'],
  textlink: ['sms.textlink.api_key'],
  twilio: ['sms.twilio.account_sid', 'sms.twilio.auth_token'],
  // 'mock' providers write to the local .outbox/ and never need secrets.
  mock: [],
};

async function missingSecretsFor(provider: string): Promise<ProviderSecretKey[]> {
  const required = REQUIRED_SECRETS_BY_PROVIDER[provider] ?? [];
  if (required.length === 0) return [];
  const metas = await listProviderSecrets();
  const configured = new Set(metas.filter((m) => m.configured).map((m) => m.key));
  return required.filter((k) => !configured.has(k));
}

adminRouter.patch(
  '/settings',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    // Pre-flight: switching emailProvider / smsProvider is only safe if the
    // target's secrets are already stored. Check once up front and 400 with a
    // list of missing keys so the admin can fix it in one pass.
    const missing: Array<{ field: string; provider: string; keys: ProviderSecretKey[] }> = [];
    if (parsed.data.emailProvider !== undefined) {
      const gap = await missingSecretsFor(parsed.data.emailProvider);
      if (gap.length > 0) {
        missing.push({ field: 'emailProvider', provider: parsed.data.emailProvider, keys: gap });
      }
    }
    if (parsed.data.smsProvider !== undefined) {
      const gap = await missingSecretsFor(parsed.data.smsProvider);
      if (gap.length > 0) {
        missing.push({ field: 'smsProvider', provider: parsed.data.smsProvider, keys: gap });
      }
    }
    if (missing.length > 0) {
      res.status(400).json({ error: 'provider_secrets_missing', missing });
      return;
    }
    const patch: Record<string, unknown> = {};
    if (parsed.data.firmName !== undefined) patch.firm_name = parsed.data.firmName;
    if (parsed.data.appName !== undefined) {
      // Empty string + null both mean "fall back to default" — store as null
      // so the security-policy resolver doesn't have to special-case empties.
      const trimmed = parsed.data.appName === null ? null : parsed.data.appName.trim() || null;
      patch.app_name = trimmed;
    }
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
    if (parsed.data.emailProvider !== undefined) patch.email_provider = parsed.data.emailProvider;
    if (parsed.data.emailFrom !== undefined) {
      // Null / empty-string both mean "clear the override; fall back to
      // env.emailFrom" — store as null so resolveEmailFrom doesn't have
      // to distinguish empty strings from missing rows.
      if (parsed.data.emailFrom === null) {
        patch.email_from = null;
      } else {
        const trimmed = parsed.data.emailFrom.trim();
        if (trimmed === '') {
          patch.email_from = null;
        } else {
          // Cheap shape check — defer the full "is this a verified
          // sender" judgement to the provider on first send. Reject the
          // bundled placeholder here so the operator can't accidentally
          // "save" the value they're trying to fix and walk away (the
          // siteUrl validator uses the same trick).
          if (!trimmed.includes('@')) {
            res.status(400).json({
              error: 'bad_request',
              field: 'emailFrom',
              reason: 'missing_at_sign',
            });
            return;
          }
          if (/vibeconnect\.local/i.test(trimmed)) {
            res.status(400).json({
              error: 'bad_request',
              field: 'emailFrom',
              reason: 'placeholder_rejected',
            });
            return;
          }
          patch.email_from = trimmed;
        }
      }
    }
    if (parsed.data.exportExternalRequiresRecoveryPhrase !== undefined)
      patch.export_external_requires_recovery_phrase =
        parsed.data.exportExternalRequiresRecoveryPhrase;
    if (parsed.data.sidebarGroupsOrder !== undefined)
      patch.sidebar_groups_order = JSON.stringify(parsed.data.sidebarGroupsOrder);
    if (parsed.data.idleLockMinutes !== undefined)
      patch.idle_lock_minutes = parsed.data.idleLockMinutes;
    if (parsed.data.clientMessagingEnabled !== undefined)
      patch.client_messaging_enabled = parsed.data.clientMessagingEnabled;
    if (parsed.data.requestsEnabled !== undefined)
      patch.requests_enabled = parsed.data.requestsEnabled;
    if (parsed.data.messageEditWindowMinutes !== undefined)
      patch.message_edit_window_minutes = parsed.data.messageEditWindowMinutes;
    if (parsed.data.messageDestructEnabled !== undefined)
      patch.message_destruct_enabled = parsed.data.messageDestructEnabled;
    if (parsed.data.messageDestructMaxSeconds !== undefined)
      patch.message_destruct_max_seconds = parsed.data.messageDestructMaxSeconds;
    if (parsed.data.smsQuietStartHour !== undefined)
      patch.sms_quiet_start_hour = parsed.data.smsQuietStartHour;
    if (parsed.data.autoNudgeEnabled !== undefined)
      patch.auto_nudge_enabled = parsed.data.autoNudgeEnabled;
    if (parsed.data.autoNudgeOffsetsHours !== undefined) {
      patch.auto_nudge_offsets_hours = parsed.data.autoNudgeOffsetsHours;
    }
    if (parsed.data.smsQuietEndHour !== undefined)
      patch.sms_quiet_end_hour = parsed.data.smsQuietEndHour;
    if (parsed.data.tlsStaffDomain !== undefined)
      patch.tls_staff_domain = parsed.data.tlsStaffDomain;
    if (parsed.data.tlsPortalDomain !== undefined)
      patch.tls_portal_domain = parsed.data.tlsPortalDomain;
    if (parsed.data.tlsAcmeEmail !== undefined) patch.tls_acme_email = parsed.data.tlsAcmeEmail;
    if (parsed.data.tlsAcmeEnvironment !== undefined)
      patch.tls_acme_environment = parsed.data.tlsAcmeEnvironment;
    if (parsed.data.tlsChallengeType !== undefined)
      patch.tls_challenge_type = parsed.data.tlsChallengeType;
    // Phase 26 — Client Vault settings.
    if (parsed.data.vaultEnabled !== undefined) patch.vault_enabled = parsed.data.vaultEnabled;
    if (parsed.data.vaultClientDelete !== undefined)
      patch.vault_client_delete = parsed.data.vaultClientDelete;
    if (parsed.data.vaultMaxFileBytes !== undefined)
      patch.vault_max_file_bytes = parsed.data.vaultMaxFileBytes;
    if (parsed.data.vaultRetentionSharedDays !== undefined)
      patch.vault_retention_shared_days = parsed.data.vaultRetentionSharedDays;
    if (parsed.data.vaultRetentionStaffDays !== undefined)
      patch.vault_retention_staff_days = parsed.data.vaultRetentionStaffDays;
    if (parsed.data.vaultFolderTemplates !== undefined)
      patch.vault_folder_templates = JSON.stringify(parsed.data.vaultFolderTemplates);
    if (parsed.data.vaultNewYearCronEnabled !== undefined)
      patch.vault_new_year_cron_enabled = parsed.data.vaultNewYearCronEnabled;
    if (parsed.data.vaultInformationBarrier !== undefined)
      patch.vault_information_barrier = parsed.data.vaultInformationBarrier;
    // Admin URL overrides — validated via normalizeAdminUrl. Reject 400
    // early so a bad save doesn't partially apply alongside other fields
    // in the same PATCH.
    if (parsed.data.siteUrl !== undefined) {
      const n = normalizeAdminUrl(parsed.data.siteUrl);
      if (!n.ok) {
        res.status(400).json({ error: 'bad_request', field: 'siteUrl', reason: n.error });
        return;
      }
      patch.site_url = n.value;
    }
    if (parsed.data.portalUrl !== undefined) {
      const n = normalizeAdminUrl(parsed.data.portalUrl);
      if (!n.ok) {
        res.status(400).json({ error: 'bad_request', field: 'portalUrl', reason: n.error });
        return;
      }
      patch.portal_url = n.value;
    }
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
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const limit =
      format === 'csv'
        ? Math.min(Number(req.query.limit ?? 10_000), 100_000)
        : Math.min(Number(req.query.limit ?? 50), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
    const actorUserId =
      typeof req.query.actorUserId === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.actorUserId)
        ? req.query.actorUserId
        : null;

    const since = parseIsoDate(req.query.since);
    const until = parseIsoDate(req.query.until);
    const reqId =
      typeof req.query.reqId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(req.query.reqId)
        ? req.query.reqId
        : null;

    const applyFilters = <Q extends Knex.QueryBuilder>(q: Q): Q => {
      if (action) {
        if (action.endsWith('*')) {
          q.whereILike('action', action.slice(0, -1).replace(/([%_])/g, '\\$1') + '%');
        } else {
          q.where('action', action);
        }
      }
      if (actorUserId) q.where('actor_user_id', actorUserId);
      if (since) q.where('created_at', '>=', since);
      if (until) q.where('created_at', '<', until);
      if (reqId) q.whereRaw(`details->>'reqId' = ?`, [reqId]);
      return q;
    };

    if (format === 'csv') {
      // Phase 28.17 — true row-by-row streaming via Knex's `.stream()`,
      // which under-the-hood uses pg's Cursor/streaming-row mode. The
      // result set is NEVER fully materialized in Node memory: rows
      // land one at a time, get CSV-encoded, and write through to the
      // response with backpressure honored. A 100k-row export uses
      // O(1) memory regardless of payload size.
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.write(
        'created_at,action,actor_user_id,actor_external_identity_id,target_type,target_id,ip_address,details\r\n',
      );
      const encode = (v: unknown): string => {
        if (v === null || v === undefined) return '';
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        return `"${s.replace(/"/g, '""')}"`;
      };
      // Apply SQL LIMIT so pg only streams what we'll consume; offset
      // honored too. orderBy keeps deterministic ordering across
      // chunked reads from the same connection.
      const stream = applyFilters(
        db('audit_log').orderBy('created_at', 'desc').limit(limit).offset(offset),
      ).stream();
      let rowCount = 0;
      let aborted = false;
      const onClose = (): void => {
        aborted = true;
        // Detach from the pg cursor so the underlying connection is
        // released promptly if the client closed mid-stream.
        if (typeof (stream as unknown as { destroy?: () => void }).destroy === 'function') {
          (stream as unknown as { destroy: () => void }).destroy();
        }
      };
      res.on('close', onClose);
      try {
        for await (const r of stream as AsyncIterable<{
          created_at: string;
          action: string;
          actor_user_id: string | null;
          actor_external_identity_id: string | null;
          target_type: string;
          target_id: string | null;
          ip_address: string | null;
          details: unknown;
        }>) {
          if (aborted) break;
          const line =
            [
              encode(new Date(r.created_at).toISOString()),
              encode(r.action),
              encode(r.actor_user_id),
              encode(r.actor_external_identity_id),
              encode(r.target_type),
              encode(r.target_id),
              encode(r.ip_address),
              encode(redactAuditDetailsForExport(r.action, r.details)),
            ].join(',') + '\r\n';
          // Honor backpressure: if the socket buffer is full, wait for
          // it to drain before pulling the next row from the cursor.
          if (!res.write(line)) {
            await new Promise<void>((resolve) => res.once('drain', resolve));
          }
          rowCount += 1;
        }
      } finally {
        res.off('close', onClose);
      }
      await auditRepo.write({
        actorUserId: req.session.userId!,
        action: 'admin.audit_export',
        targetType: 'audit_log',
        details: { action, actorUserId, rowCount, format, aborted },
      });
      res.end();
      return;
    }

    // Fetch one extra to know if there's a next page without a separate COUNT query.
    const fetched = await applyFilters(
      db('audit_log')
        .orderBy('created_at', 'desc')
        .limit(limit + 1)
        .offset(offset),
    );
    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;
    res.json({
      hasMore,
      limit,
      offset,
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
    const row = await db('user_keys').where({ id: req.params.id! }).first();
    // 404 up front so we don't mutate anything, skip the session-terminate
    // call with a null user_id (which matches no rows and silently no-ops),
    // and don't audit-log a fake revoke event for a device that never existed.
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await db('user_keys').where({ id: req.params.id! }).update({ revoked_at: db.fn.now() });
    // Terminate all sessions for the owning user. They may have other active devices
    // and can re-enroll this one with a fresh keypair after signing back in.
    const sessionsTerminated = await terminateSessionsForUser(row.user_id);
    // CRYPTO: purge the revoked device's wrapped_keys entries from every
    // conversation. Without this, the revoked device retains a valid sealed
    // copy of every conversation key it was ever included in — if the device
    // or its key material is later re-imported, all history is readable. We
    // can't force a rotation server-side (we don't have the conversation
    // keys), but deleting the stale entries closes the re-import path.
    const recipientKey = `${row.user_id}:${row.device_id}`;
    const result = await db('conversation_keys').update({
      wrapped_keys: db.raw(`wrapped_keys - ?::text`, [recipientKey]),
    });
    const wrappedKeysStripped = typeof result === 'number' ? result : 0;
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.device_revoked',
      targetType: 'user_key',
      targetId: req.params.id!,
      details: {
        userId: row.user_id,
        deviceId: row.device_id,
        sessionsTerminated,
        wrappedKeysStripped,
      },
    });
    res.json({ ok: true, sessionsTerminated, wrappedKeysStripped });
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

// ---------- Client (external_identity) management ----------

// Visible to any authenticated staff. The clients list is firm-scoped (not
// per-staff-scoped), so every staff member sees the same rows — this is
// safe-by-design because external_identities don't carry staff_id. Mutations
// below (POST .../deactivate, .../reactivate, .../forget, POST /clients)
// remain admin-only — the legal/compliance posture for client lifecycle
// changes hasn't changed.
adminRouter.get(
  '/clients',
  requireAuth,
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const includeDeactivated = req.query.includeDeactivated === 'true';
    let q = db('external_identities as e')
      .leftJoin(
        db('client_sessions')
          .whereNull('revoked_at')
          .andWhere('absolute_expires_at', '>', db.fn.now())
          .select('external_identity_id', db.raw('COUNT(*)::int as "activeSessions"'))
          .groupBy('external_identity_id')
          .as('ls'),
        'ls.external_identity_id',
        'e.id',
      )
      .select(
        'e.id',
        'e.email',
        'e.phone',
        'e.display_name as displayName',
        'e.firm_client_ref as firmClientRef',
        'e.verification_type as verificationType',
        'e.verification_required as verificationRequired',
        'e.first_invited_at as firstInvitedAt',
        'e.last_active_at as lastActiveAt',
        'e.deactivated_at as deactivatedAt',
        'e.invited_at as invitedAt',
        'e.invited_via as invitedVia',
        'e.invite_public_key as invitePublicKey',
        db.raw('COALESCE(ls."activeSessions", 0) as "activeSessions"'),
      )
      .orderBy('e.display_name');
    if (!includeDeactivated) q = q.whereNull('e.deactivated_at');
    if (search) {
      q = q.andWhere((b) => {
        b.whereILike('e.display_name', `%${search}%`)
          .orWhereILike('e.email', `%${search}%`)
          .orWhereILike('e.phone', `%${search}%`)
          .orWhereILike('e.firm_client_ref', `%${search}%`);
      });
    }
    const rows = await q.limit(200);
    res.json({ clients: rows });
  }),
);

// ---------- Create + (re)invite client ----------

const createClientSchema = z
  .object({
    displayName: z.string().min(1).max(128),
    email: z.string().email().max(255).optional().nullable(),
    phone: z.string().min(6).max(32).optional().nullable(),
    firmClientRef: z.string().max(128).optional().nullable(),
    inviteVia: z.enum(['email', 'sms']),
  })
  .refine((v) => !!(v.inviteVia === 'email' ? v.email : v.phone), {
    message: 'inviteVia=email requires email; inviteVia=sms requires phone',
  });

adminRouter.post(
  '/clients',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = createClientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const email = (parsed.data.email ?? '').trim().toLowerCase() || null;
    // Canonicalise phone at store time so inbound SMS lookups (which match on
    // phone exact-equal in smsBridge.ts) hit the same string. Without this an
    // admin entering "555-123-4567" would store a different value than the
    // identify flow's normalised "+15551234567" produces.
    const rawPhone = (parsed.data.phone ?? '').trim();
    const phone = rawPhone ? (normalizePhone(rawPhone) ?? null) : null;
    if (rawPhone && !phone) {
      res.status(400).json({ error: 'invalid_phone', detail: 'phone too short or malformed' });
      return;
    }
    // Reject duplicates up front (the unique index on email would do the same but
    // a friendly error is kinder).
    if (email) {
      const existing = await db('external_identities').where({ email }).first();
      if (existing) {
        res.status(409).json({ error: 'email_taken', existingId: existing.id });
        return;
      }
    }
    const invite = await generateInviteMaterial();
    const [row] = await db('external_identities')
      .insert({
        email: email ?? `no-email-${randomBytes(4).toString('hex')}@placeholder.invalid`,
        phone,
        display_name: parsed.data.displayName,
        firm_client_ref: parsed.data.firmClientRef ?? null,
        verification_type: 'none',
        verification_required: false,
        invite_token_hash: invite.tokenHash,
        invite_public_key: invite.publicKey,
        invited_at: db.fn.now(),
        invited_via: parsed.data.inviteVia,
      })
      .returning(['id']);
    const identityId = (row as { id: string }).id;
    const [firmSettingsRow, actorRow] = await Promise.all([
      db('firm_settings').where({ id: 1 }).first(),
      db('users').where({ id: req.session.userId! }).first(),
    ]);
    try {
      await sendClientInvite({
        identityId,
        displayName: parsed.data.displayName,
        via: parsed.data.inviteVia,
        email,
        phone,
        token: invite.token,
        firmName: (firmSettingsRow?.firm_name as string | undefined) ?? null,
        fromDisplayName: (actorRow?.display_name as string | undefined) ?? null,
      });
    } catch (err) {
      // We already persisted the identity + invite material. Return a partial success
      // with the error so the admin can hit "Send invite" again once the provider is fixed.
      await auditRepo.write({
        actorUserId: req.session.userId!,
        action: 'admin.client_invite_send_failed',
        targetType: 'external_identity',
        targetId: identityId,
        details: {
          via: parsed.data.inviteVia,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      res.status(201).json({
        id: identityId,
        invitePublicKey: invite.publicKey,
        inviteSent: false,
        sendError: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.client_created',
      targetType: 'external_identity',
      targetId: identityId,
      details: { via: parsed.data.inviteVia, hasEmail: !!email, hasPhone: !!phone },
    });
    res.status(201).json({ id: identityId, invitePublicKey: invite.publicKey, inviteSent: true });
  }),
);

adminRouter.post(
  '/clients/:id/reinvite',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await db('external_identities').where({ id: req.params.id! }).first();
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // v0.4.33: default behavior is now "send via every channel the
    // client has on file" — a client with both email and phone gets
    // both, raising the odds they spot the invite on whichever inbox
    // they check first. The optional `via` body param still honors an
    // explicit single-channel override (legacy callers / admin Test
    // button) but is no longer required.
    const body = z
      .object({ via: z.enum(['email', 'sms', 'both']).optional() })
      .safeParse(req.body ?? {});
    const explicitVia = body.success ? body.data.via : undefined;
    const hasEmail = typeof row.email === 'string' && row.email.length > 0;
    const hasPhone = typeof row.phone === 'string' && row.phone.length > 0;
    // When the client has only one channel configured, downgrade
    // 'both' to that channel rather than triggering the
    // no_channel_configured throw inside sendClientInvite.
    let via: 'email' | 'sms' | 'both';
    if (explicitVia) {
      via = explicitVia;
    } else if (hasEmail && hasPhone) {
      via = 'both';
    } else if (hasEmail) {
      via = 'email';
    } else if (hasPhone) {
      via = 'sms';
    } else {
      // No channels at all on the row — record on invited_via to keep
      // the schema honest, but sendClientInvite would reject anyway.
      via = (row.invited_via as 'email' | 'sms' | null) ?? 'email';
    }
    const invite = await generateInviteMaterial();
    await db('external_identities')
      .where({ id: req.params.id! })
      .update({
        invite_token_hash: invite.tokenHash,
        invite_public_key: invite.publicKey,
        invited_at: db.fn.now(),
        // `invited_via` on the row is a single-value enum-ish field;
        // 'both' would break downstream lookups that expect 'email' or
        // 'sms'. Store the primary channel (email when both, otherwise
        // whichever was used) — `via` in the audit row captures the
        // multi-channel intent.
        invited_via: via === 'both' ? 'email' : via,
        deactivated_at: null,
      });
    const [firmSettingsRow, actorRow] = await Promise.all([
      db('firm_settings').where({ id: 1 }).first(),
      db('users').where({ id: req.session.userId! }).first(),
    ]);
    let sendResult: Awaited<ReturnType<typeof sendClientInvite>> | null = null;
    try {
      sendResult = await sendClientInvite({
        identityId: req.params.id!,
        displayName: row.display_name as string,
        via,
        email: (row.email as string) || null,
        phone: (row.phone as string) || null,
        token: invite.token,
        firmName: (firmSettingsRow?.firm_name as string | undefined) ?? null,
        fromDisplayName: (actorRow?.display_name as string | undefined) ?? null,
      });
    } catch (err) {
      await auditRepo.write({
        actorUserId: req.session.userId!,
        action: 'admin.client_invite_send_failed',
        targetType: 'external_identity',
        targetId: req.params.id!,
        details: { via, error: err instanceof Error ? err.message : String(err) },
      });
      res.status(200).json({
        ok: true,
        invitePublicKey: invite.publicKey,
        inviteSent: false,
        sendError: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.client_reinvited',
      targetType: 'external_identity',
      targetId: req.params.id!,
      details: {
        via,
        emailStatus: sendResult.email.status,
        smsStatus: sendResult.sms.status,
      },
    });
    // Surface per-channel outcome so the staff UI can render
    // "email sent, sms failed" instead of a single ok/fail bit. A
    // 'both' call where one channel succeeded and the other failed
    // is still inviteSent=true because the client has a working
    // delivery path.
    res.json({
      ok: true,
      invitePublicKey: invite.publicKey,
      inviteSent: sendResult.email.status === 'sent' || sendResult.sms.status === 'sent',
      delivery: {
        email: sendResult.email.status,
        sms: sendResult.sms.status,
      },
    });
  }),
);

adminRouter.post(
  '/clients/:id/deactivate',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await db('external_identities').where({ id: req.params.id! }).first();
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Atomic so the deactivation flag and session revocation can never disagree.
    const revoked = await db.transaction(async (trx) => {
      await trx('external_identities')
        .where({ id: req.params.id! })
        .update({ deactivated_at: trx.fn.now() });
      return trx('client_sessions')
        .where({ external_identity_id: req.params.id })
        .whereNull('revoked_at')
        .update({ revoked_at: trx.fn.now() });
    });
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.client_deactivated',
      targetType: 'external_identity',
      targetId: req.params.id!,
      details: { sessionsRevoked: revoked },
    });
    res.json({ ok: true, sessionsRevoked: revoked });
  }),
);

adminRouter.post(
  '/clients/:id/reactivate',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await db('external_identities').where({ id: req.params.id! }).first();
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await db('external_identities').where({ id: req.params.id! }).update({ deactivated_at: null });
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.client_reactivated',
      targetType: 'external_identity',
      targetId: req.params.id!,
    });
    res.json({ ok: true });
  }),
);

// GDPR "right to erasure": anonymize PII while preserving FK integrity so audit
// trail + historical conversation membership stay intact. This is irreversible —
// the original name/email/phone are not recoverable. Messages the client sent
// remain (as ciphertext), but attribute to the anonymized row.
adminRouter.post(
  '/clients/:id/forget',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await db('external_identities').where({ id: req.params.id! }).first();
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Use the full UUID in the anonymized email to keep the unique constraint collision-free
    // even at tens of thousands of clients (first-8-hex collides at ~16k rows).
    const fullId = req.params.id as string;
    const anonEmail = `deleted-${fullId}@deleted.invalid`;
    const anonName = `Forgotten client ${fullId.slice(0, 8)}`;
    await db.transaction(async (trx) => {
      // Revoke all sessions first so the client can't read the anonymized row.
      await trx('client_sessions')
        .where({ external_identity_id: req.params.id })
        .whereNull('revoked_at')
        .update({ revoked_at: trx.fn.now() });
      await trx('external_identities').where({ id: req.params.id! }).update({
        email: anonEmail,
        phone: null,
        display_name: anonName,
        firm_client_ref: null,
        verification_last4_hash: null,
        verification_type: 'none',
        verification_required: false,
        preferences: {},
        deactivated_at: trx.fn.now(),
      });
      // Delete any open access-code rows since they referenced the original email/phone.
      await trx('access_codes').where({ external_identity_id: req.params.id }).del();
    });
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.client_forgotten',
      targetType: 'external_identity',
      targetId: req.params.id!,
      details: { originalEmailHash: hashForAudit(row.email as string) },
    });
    res.json({ ok: true, anonymizedEmail: anonEmail });
  }),
);

// ---------- Client portal session visibility ----------
// Lists currently-active (non-revoked, non-expired) client portal sessions so an
// admin can see who's connected right now and revoke them if needed. Clients log
// in via access code → sessions live until revoked or expired.

adminRouter.get(
  '/client-sessions',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await db('client_sessions as s')
      .leftJoin('external_identities as e', 'e.id', 's.external_identity_id')
      .whereNull('s.revoked_at')
      .andWhere('s.absolute_expires_at', '>', db.fn.now())
      .select(
        's.id',
        's.external_identity_id as externalIdentityId',
        's.created_at as createdAt',
        's.absolute_expires_at as expiresAt',
        's.last_seen_at as lastSeenAt',
        's.verified_until as verifiedUntil',
        's.user_agent as userAgent',
        's.ip_address as ipAddress',
        'e.display_name as displayName',
        'e.email',
        'e.phone',
      )
      .orderBy('s.last_seen_at', 'desc');
    res.json({ sessions: rows });
  }),
);

adminRouter.post(
  '/client-sessions/:id/revoke',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sess = await db('client_sessions').where({ id: req.params.id! }).first();
    if (!sess) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await db('client_sessions').where({ id: req.params.id! }).update({ revoked_at: db.fn.now() });
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.client_session_revoked',
      targetType: 'client_session',
      targetId: req.params.id!,
      details: { externalIdentityId: sess.external_identity_id },
    });
    res.json({ ok: true });
  }),
);

// ---------- Conversation listing for admins ----------
// Needed by the Admin → Export UI: an admin may need to decrypt/export a conversation
// they are NOT a member of (emergency decrypt, compliance hold, etc.). This listing
// deliberately does NOT include message ciphertext — just metadata.
adminRouter.get(
  '/conversations',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const type = typeof req.query.type === 'string' ? req.query.type : '';
    let q = db('conversations as c')
      .select(
        'c.id',
        'c.type',
        'c.display_name as displayName',
        'c.created_at as createdAt',
        'c.updated_at as updatedAt',
        db.raw(
          `(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)::int AS "messageCount"`,
        ),
        db.raw(
          `(SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.removed_at IS NULL)::int AS "memberCount"`,
        ),
      )
      .orderBy('c.updated_at', 'desc')
      .limit(limit + 1)
      .offset(offset);
    if (type === 'internal' || type === 'external') q = q.where('c.type', type);
    const fetched = await q;
    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;
    res.json({ hasMore, limit, offset, conversations: rows });
  }),
);

// ---------- Per-conversation export ----------

const exportSchema = z.object({
  conversationId: z.string().uuid(),
  recoveryPhrase: z.array(z.string()).optional(),
  includeTeamNotes: z.boolean().default(false),
});

// Exports read every message + every conversation-key row. Cap at 10/hour per
// admin so a runaway script can't exfiltrate the whole firm archive in minutes.
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
  keyGenerator: (req) => req.session.userId ?? req.ip ?? 'anon',
});

adminRouter.post(
  '/export',
  requireAdmin,
  exportLimiter,
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

// ---------- Phase 27: per-message history (admin) ----------
//
// Returns the live message row + every snapshot from `message_edits` + the
// conversation's wrapped-key bundle. Admin client decrypts in-browser. Same
// shape as /admin/export so the frontend can re-use the existing decrypt
// helpers; this endpoint is just narrower scope (one message vs. an entire
// conversation).
//
// Rate-limited at 30/hour/admin so a script can't pull every edit history
// in the firm in a single sitting. Each call audits — that gives the firm
// owner a paper trail of which messages were inspected.
const historyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
  keyGenerator: (req) => req.session.userId ?? req.ip ?? 'anon',
});

adminRouter.get(
  '/messages/:id/history',
  requireAdmin,
  historyLimiter,
  asyncHandler(async (req, res) => {
    const msg = await db('messages').where({ id: req.params.id! }).first();
    if (!msg) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const edits = await db('message_edits')
      .where({ message_id: msg.id })
      .orderBy('replaced_at', 'asc');
    const conv = await db('conversations').where({ id: msg.conversation_id }).first();
    const keys = await db('conversation_keys')
      .where({ conversation_id: msg.conversation_id })
      .orderBy('rotation_version', 'asc');
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.message_history_viewed',
      targetType: 'message',
      targetId: msg.id,
      details: {
        conversationId: msg.conversation_id,
        editCount: edits.length,
        deleted: msg.deleted_at !== null,
      },
    });
    res.json({
      conversation: conv
        ? {
            id: conv.id,
            type: conv.type,
            displayName: conv.display_name,
          }
        : null,
      message: {
        id: msg.id,
        senderId: msg.sender_id,
        senderExternalIdentityId: msg.sender_external_identity_id,
        // Always emit ciphertext for admins — even on deleted rows. That's the
        // entire point of this endpoint vs. the recipient-facing list.
        ciphertext: (msg.ciphertext as Buffer).toString('base64'),
        ciphertextMeta: msg.ciphertext_meta,
        contentKeyVersion: msg.content_key_version,
        source: msg.source,
        createdAt: msg.created_at,
        editedAt: msg.edited_at,
        deletedAt: msg.deleted_at,
        destructAfterViewSeconds: msg.destruct_after_view_seconds,
        destructAt: msg.destruct_at,
      },
      edits: edits.map((e) => ({
        id: e.id,
        ciphertext: (e.ciphertext as Buffer).toString('base64'),
        ciphertextMeta: e.ciphertext_meta,
        contentKeyVersion: e.content_key_version,
        replacedAt: e.replaced_at,
        replacedByUserId: e.replaced_by_user_id,
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
  // Cap at 500 per request — the admin page parses a CSV client-side so the UX can
  // chunk larger imports. Keeps the per-request transaction bounded.
  users: z
    .array(
      z.object({
        username: z.string().min(2).max(64),
        email: z.string().email().optional(),
        displayName: z.string().min(1).max(128),
        initialPassword: z.string().min(12).max(512),
        isAdmin: z.boolean().optional(),
        groupIds: z.array(z.string().uuid()).optional(),
      }),
    )
    .min(1)
    .max(500),
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

// ---------- Provider credentials (Twilio / TextLink / Postmark / SMTP) ----------
//
// Admin-writable, sealed-at-rest credentials for outbound SMS + email. The
// API is metadata-only on reads (never the plaintext) — the bridges fetch
// plaintext in-process via providerSecrets.get(). Both writes and clears
// audit-log but the audit row carries only a SHA-256 fingerprint + last-4
// so operators can tell that a rotation happened (and distinguish two
// rotations of the same value) without exposing the secret.

// Single endpoint per verb, keyed by the registry name. Rate-limited to
// ward off an admin-session-compromise brute-rotation; value shape is an
// opaque string so each provider's own validation runs at send time.
const providerSecretWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
  keyGenerator: (req) => req.session.userId ?? req.ip ?? 'anon',
});

adminRouter.get(
  '/providers',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const items = await listProviderSecrets();
    res.json({ items, knownKeys: PROVIDER_SECRET_KEYS });
  }),
);

adminRouter.put(
  '/providers/:key',
  requireAdmin,
  providerSecretWriteLimiter,
  asyncHandler(async (req, res) => {
    const key = req.params.key ?? '';
    if (!isKnownProviderSecretKey(key)) {
      res.status(400).json({ error: 'unknown_key' });
      return;
    }
    const body = z.object({ value: z.string().min(1).max(4096) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    try {
      const meta = await setProviderSecret(
        key as ProviderSecretKey,
        body.data.value,
        req.session.userId ?? null,
      );
      res.json({ meta });
    } catch (err) {
      // Never echo the offending value. Only surface the category of failure.
      const msg = err instanceof Error ? err.message : 'error';
      if (msg === 'provider_secret_empty') {
        res.status(400).json({ error: 'empty_value' });
        return;
      }
      throw err;
    }
  }),
);

adminRouter.delete(
  '/providers/:key',
  requireAdmin,
  providerSecretWriteLimiter,
  asyncHandler(async (req, res) => {
    const key = req.params.key ?? '';
    if (!isKnownProviderSecretKey(key)) {
      res.status(400).json({ error: 'unknown_key' });
      return;
    }
    await clearProviderSecret(key as ProviderSecretKey, req.session.userId ?? null);
    const items = await listProviderSecrets();
    res.json({ meta: items.find((m) => m.key === key) });
  }),
);

// ---------- Provider test send ----------
//
// Admin → Providers exposes a "Test" button per provider. The button
// POSTs here with the specific provider kind + a recipient address; the
// server instantiates THAT provider (not the currently-resolved one) and
// sends a small fixed test message. Returns the provider's reported
// message id on success or the error string on failure — both are echoed
// in the UI so the admin can immediately see what's wrong with their
// credentials. Audit-logged so a compromise leaves a trail.
//
// Rate-limited tightly: a test send is an outbound API call to a paid
// provider; we don't want a stuck UI / bug to drain the firm's quota.
const providerTestSendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const testEmailBody = z.object({
  provider: z.enum(['postmark', 'postfix', 'emailit', 'mock']),
  to: z.string().email().max(254),
});

adminRouter.post(
  '/providers/test/email',
  requireAdmin,
  providerTestSendLimiter,
  asyncHandler(async (req, res) => {
    const parsed = testEmailBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.flatten() });
      return;
    }
    const { provider, to } = parsed.data;
    const gap = await missingSecretsFor(provider);
    if (gap.length > 0) {
      res.status(400).json({ error: 'provider_secrets_missing', keys: gap });
      return;
    }
    const { buildEmailProvider } = await import('../bridges/email/index.js');
    const impl = buildEmailProvider(provider);
    const stamp = new Date().toISOString();
    try {
      const result = await impl.send({
        to,
        subject: 'Vibe Connect — test email',
        text: `This is a test email from Vibe Connect's Admin → Providers diagnostic.\n\nProvider: ${provider}\nSent at: ${stamp}\n\nIf you received this, ${provider} is configured correctly.`,
      });
      await auditRepo.write({
        actorUserId: req.session.userId!,
        action: 'admin.provider_test_sent',
        targetType: 'firm_settings',
        targetId: 'email',
        details: { provider, status: 'sent', messageId: result.id },
        ipAddress: req.ip ?? null,
      });
      res.json({ ok: true, providerMessageId: result.id, status: result.status });
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      await auditRepo.write({
        actorUserId: req.session.userId!,
        action: 'admin.provider_test_sent',
        targetType: 'firm_settings',
        targetId: 'email',
        details: { provider, status: 'failed', reason: reason.slice(0, 200) },
        ipAddress: req.ip ?? null,
      });
      res.status(502).json({ ok: false, error: reason });
    }
  }),
);

const testSmsBody = z.object({
  provider: z.enum(['twilio', 'textlink', 'mock']),
  to: z
    .string()
    .min(7)
    .max(20)
    .regex(/^\+?[0-9\s\-()]+$/, 'must look like a phone number'),
});

adminRouter.post(
  '/providers/test/sms',
  requireAdmin,
  providerTestSendLimiter,
  asyncHandler(async (req, res) => {
    const parsed = testSmsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.flatten() });
      return;
    }
    const { provider, to } = parsed.data;
    const gap = await missingSecretsFor(provider);
    if (gap.length > 0) {
      res.status(400).json({ error: 'provider_secrets_missing', keys: gap });
      return;
    }
    const { buildSmsProvider } = await import('../bridges/sms/index.js');
    const impl = buildSmsProvider(provider);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    // Real E.164 normalisation (handles US 10-digit, 11-digit with
    // leading 1, formatted variants like "(417) 555-4645", etc.). The
    // older code just stripped formatting and prepended `+`, which
    // turned a bare US 10-digit into `+4175554645` — `+4` isn't a
    // valid country code and TextLink/Twilio would reject. See
    // services/phoneFormat.ts for the full ruleset.
    const { normalizeE164 } = await import('../services/phoneFormat.js');
    const normalisedTo = normalizeE164(to);
    if (!normalisedTo) {
      res.status(400).json({
        error: 'invalid_phone',
        message:
          "Couldn't parse as a phone number. Use E.164 (+15551234567), or a US 10-digit / 11-digit number.",
      });
      return;
    }
    try {
      const result = await impl.sendMessage({
        to: normalisedTo,
        body: `Vibe Connect test SMS via ${provider} at ${stamp} UTC. If you received this, the provider is configured correctly. Reply STOP to opt out.`,
      });
      await auditRepo.write({
        actorUserId: req.session.userId!,
        action: 'admin.provider_test_sent',
        targetType: 'firm_settings',
        targetId: 'sms',
        details: { provider, status: 'sent', messageId: result.id },
        ipAddress: req.ip ?? null,
      });
      res.json({ ok: true, providerMessageId: result.id, status: result.status });
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      await auditRepo.write({
        actorUserId: req.session.userId!,
        action: 'admin.provider_test_sent',
        targetType: 'firm_settings',
        targetId: 'sms',
        details: { provider, status: 'failed', reason: reason.slice(0, 200) },
        ipAddress: req.ip ?? null,
      });
      res.status(502).json({ ok: false, error: reason });
    }
  }),
);

// ---------- Retention sweep (on-demand) ----------

adminRouter.post(
  '/retention/run',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await runRetentionSweep();
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.retention_run',
      targetType: 'firm',
      details: { ...result },
    });
    res.json(result);
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

firmRouter.get(
  '/key-meta',
  asyncHandler(async (_req, res) => {
    const row = await db('firm_keys').whereNull('retired_at').first();
    if (!row) {
      res.status(404).json({ error: 'not_installed' });
      return;
    }
    res.json({
      publicKey: row.public_key,
      rotationVersion: row.rotation_version,
      createdAt: row.created_at,
    });
  }),
);

// Security policy readable by any authenticated staff user so their client can
// enforce the admin-chosen idle-lock timeout. Contains only non-sensitive values.
// Also surfaces a few firm-display fields (name, step-up default, SMS reachability)
// so pre-staff surfaces like the Invite-a-client modal render without extra round-trips.
firmRouter.get(
  '/security-policy',
  asyncHandler(async (req, res) => {
    if (!req.session.userId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const row = await db('firm_settings').where({ id: 1 }).first();
    const provider = (row?.sms_provider as string | undefined) ?? 'mock';
    const appName = (row?.app_name as string | null | undefined) ?? null;
    res.json({
      idleLockMinutes: Number(row?.idle_lock_minutes ?? 15),
      clientMessagingEnabled: Boolean(row?.client_messaging_enabled ?? true),
      requestsEnabled: Boolean(row?.requests_enabled ?? true),
      vaultEnabled: Boolean(row?.vault_enabled ?? true),
      firmName: (row?.firm_name as string | undefined) ?? 'Your Firm',
      // Null when the admin hasn't set a brand override; the staff app falls
      // back to the default "Vibe Connect" string client-side.
      appName: appName && appName.trim() ? appName.trim() : null,
      stepupTimeoutHours: Number(row?.stepup_timeout_hours ?? 24),
      // Treat 'mock' as unavailable in production so staff aren't misled; dev/test
      // environments see it as available so mock-provider smoke tests still work.
      smsAvailable: provider === 'textlink' || provider === 'twilio' || provider === 'mock',
      // Phase 27: edit window and self-destruct knobs. The staff client uses
      // these to gate the bubble-menu Edit button (hidden after the window)
      // and the compose dropdown (hidden when destruct is firm-disabled).
      messageEditWindowMinutes: Number(row?.message_edit_window_minutes ?? 15),
      messageDestructEnabled: Boolean(row?.message_destruct_enabled ?? true),
      messageDestructMaxSeconds: Number(row?.message_destruct_max_seconds ?? 604800),
    });
  }),
);

// Phase 26: vault folder templates readable by any authenticated staff.
// `vault_folder_templates` is firm-internal cleartext config (the server has
// no encrypted-on-server template); staff see it indirectly any time they
// apply a template, so exposing it on the staff-readable endpoint is fine.
firmRouter.get(
  '/vault-templates',
  asyncHandler(async (req, res) => {
    if (!req.session.userId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const row = await db('firm_settings').where({ id: 1 }).first('vault_folder_templates');
    const raw = row?.vault_folder_templates;
    const templates = Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? (JSON.parse(raw) as unknown)
        : [];
    res.json({ templates });
  }),
);

// Admin-only. Returns the encrypted recovery-private-key record so an admin
// can derive the firm private key client-side (from the 24-word phrase) and
// rewrap conversations onto a new device when every other device has been
// revoked/lost. The server never sees the phrase or the derived key.
adminRouter.get(
  '/firm/recovery-record',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await db('firm_keys').whereNull('retired_at').first();
    if (!row) {
      res.status(404).json({ error: 'not_installed' });
      return;
    }
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.recovery_record_viewed',
      targetType: 'firm_key',
      targetId: row.id,
      details: {},
      ipAddress: req.ip ?? null,
    });
    res.json({
      publicKey: row.public_key,
      encryptedRecoveryPrivateKey: row.encrypted_recovery_private_key,
      kdfSalt: row.kdf_salt,
      kdfParams: row.kdf_params,
      rotationVersion: row.rotation_version,
    });
  }),
);

// ---------- Backup criticality + key fingerprint ----------
//
// Loss of the firm key (DB-resident in firm_keys) without a backup is
// unrecoverable: every encrypted message and vault file becomes opaque
// ciphertext forever. The backup heartbeat lets an external runner
// (Duplicati on the appliance, a cron-driven pg_dump on standalone)
// signal that a successful capture happened. The admin dashboard reads
// the staleness back; when BACKUP_REQUIRED is on, the staleness also
// gates new vault uploads via vaultBackupGate (loaded into the upload
// routers separately).

adminRouter.get(
  '/key-status',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const fk = (await db('firm_keys')
      .whereNull('retired_at')
      .first('public_key', 'rotation_version', 'created_at')) as
      | { public_key: string; rotation_version: number; created_at: Date }
      | undefined;
    const settings = (await db('firm_settings')
      .where({ id: 1 })
      .first('last_backup_ok_at', 'last_backup_recorded_at', 'last_backup_status')) as
      | {
          last_backup_ok_at: Date | null;
          last_backup_recorded_at: Date | null;
          last_backup_status: unknown;
        }
      | undefined;

    const fingerprint = fk
      ? createHash('sha256').update(fk.public_key, 'utf8').digest('hex').slice(0, 16)
      : null;

    const lastOk = settings?.last_backup_ok_at ?? null;
    const daysSinceBackup = lastOk
      ? Math.floor((Date.now() - new Date(lastOk).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // Distinguish three states the UI cares about:
    //   - 'ok'      : last backup within warn window
    //   - 'warn'    : older than warnDays (banner appears)
    //   - 'blocked' : older than blockDays (vault uploads refused)
    //   - 'never'   : no heartbeat ever recorded
    let state: 'ok' | 'warn' | 'blocked' | 'never';
    if (!lastOk) state = 'never';
    else if (daysSinceBackup !== null && daysSinceBackup >= env.backupBlockDays) state = 'blocked';
    else if (daysSinceBackup !== null && daysSinceBackup >= env.backupWarnDays) state = 'warn';
    else state = 'ok';

    res.json({
      firmKey: {
        installed: !!fk,
        fingerprint,
        rotationVersion: fk?.rotation_version ?? null,
        installedAt: fk?.created_at ?? null,
      },
      backup: {
        required: env.backupRequired,
        warnDays: env.backupWarnDays,
        blockDays: env.backupBlockDays,
        lastOkAt: lastOk,
        lastRecordedAt: settings?.last_backup_recorded_at ?? null,
        lastStatus: settings?.last_backup_status ?? null,
        daysSinceBackup,
        state,
      },
    });
  }),
);

// Bearer-token-authenticated endpoint for an external backup runner. The
// staff session model doesn't fit Duplicati — it has no browser, no
// password reset story, and runs on a cron timer where an interactive
// re-login is impossible. A long opaque token shipped to the appliance
// at install time is the right shape: easy to rotate, easy to scope
// (this token grants nothing else), easy to revoke (clear the env var).
//
// Token comparison is timing-safe via Node's `timingSafeEqual` to keep
// the authentication step from leaking byte-position information through
// response timing. Empty configured token = endpoint is permanently 401
// (the appliance must set BACKUP_HEARTBEAT_TOKEN; see env.ts).
adminRouter.post(
  '/backup-heartbeat',
  asyncHandler(async (req, res) => {
    const auth = req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const presented = m ? (m[1] ?? '') : '';
    const expected = env.backupHeartbeatToken;
    if (!expected || presented.length !== expected.length) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    const { timingSafeEqual } = await import('node:crypto');
    if (!timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const okSchema = z.object({
      ok: z.boolean(),
      // Free-form structured detail. Cap roughly via JSON parse limit
      // upstream (1 MB DEFAULT_BODY in app.ts) — no per-field check.
      status: z.unknown().optional(),
    });
    const parsed = okSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_payload' });
      return;
    }
    const now = new Date();
    const update: Record<string, unknown> = {
      last_backup_recorded_at: now,
      last_backup_status: parsed.data.status ?? null,
    };
    if (parsed.data.ok) update.last_backup_ok_at = now;
    await db('firm_settings').where({ id: 1 }).update(update);
    logger.info('backup.heartbeat', {
      ok: parsed.data.ok,
      hasStatus: parsed.data.status !== undefined,
    });
    res.json({ ok: true });
  }),
);

// ---------- Staff-facing client directory ----------
//
// Any authenticated staff member needs to see the firm's client book so they can
// start or find a conversation. Distinct from /admin/clients (admin-only, full
// lifecycle controls) — this endpoint is read-only and returns only what's needed
// to wrap a conversation key to the client: invite_public_key for pre-activation
// clients, plus whether they have an active portal session.
export const clientsRouter = Router();
clientsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const rows = await db('external_identities as e')
      .leftJoin(
        db('client_sessions')
          .select('external_identity_id')
          .count<{ external_identity_id: string; activeSessions: string }>('* as activeSessions')
          .whereNull('revoked_at')
          .andWhere('absolute_expires_at', '>', db.fn.now())
          .groupBy('external_identity_id')
          .as('ls'),
        'ls.external_identity_id',
        'e.id',
      )
      .whereNull('e.deactivated_at')
      .andWhere((b) => {
        // Reachable = either has an active portal session OR has a live invite
        // key we can still wrap to.
        b.whereNotNull('e.invite_public_key').orWhereRaw('COALESCE(ls."activeSessions", 0) > 0');
      })
      .select(
        'e.id',
        'e.display_name as displayName',
        'e.email',
        'e.phone',
        'e.firm_client_ref as firmClientRef',
        'e.last_active_at as lastActiveAt',
        'e.invite_public_key as invitePublicKey',
        'e.invited_at as invitedAt',
        'e.invited_via as invitedVia',
        'e.verification_type as verificationType',
        'e.preferences as preferences',
        db.raw('COALESCE(ls."activeSessions", 0)::int as "activeSessions"'),
      )
      .orderBy('e.display_name')
      .limit(500);
    // Surface the subset of `preferences` the resend-invite modal needs so the
    // sidebar can pre-fill the re-verify choice + channel toggles without a
    // second round-trip. Keeping the raw JSON behind the resolver means we
    // never leak non-public preference keys to staff who don't need them.
    // Placeholder emails (e.g. `no-email-XXXX@placeholder.invalid`) exist only
    // to satisfy the NOT NULL + UNIQUE index on SMS-only identities — treat
    // them as "no email" when surfacing to the UI so the resend modal doesn't
    // pre-fill a bogus address into the textbox.
    const shaped = rows.map((r) => {
      const prefs = (r.preferences as Record<string, unknown> | null) ?? {};
      const reverify = prefs.reverify_every_hours;
      const reverifyEveryHours =
        reverify === 4 || reverify === 8 || reverify === 24 || reverify === 168
          ? (reverify as 4 | 8 | 24 | 168)
          : reverify === null
            ? null
            : undefined;
      const emailNotifications =
        typeof prefs.email_notifications === 'boolean' ? prefs.email_notifications : undefined;
      const smsNotifications =
        typeof prefs.sms_notifications === 'boolean' ? prefs.sms_notifications : undefined;
      const { preferences: _omit, ...rest } = r as Record<string, unknown>;
      const email = typeof rest.email === 'string' ? rest.email : null;
      const isPlaceholderEmail = email !== null && /@placeholder\.invalid$/i.test(email);
      return {
        ...rest,
        email: isPlaceholderEmail ? null : email,
        reverifyEveryHours,
        emailNotifications,
        smsNotifications,
      };
    });
    res.json({ clients: shaped });
  }),
);

// Per-client session public keys. Staff need these so startConversation can wrap
// the shared conversation key to every live portal session. Returns empty array
// when the client is still pre-activation (caller should wrap to invitePublicKey
// instead — the /clients row above exposes that).
clientsRouter.get(
  '/:id([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/session-keys',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const identity = await db('external_identities').where({ id }).first();
    if (!identity || identity.deactivated_at) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const sessions = await db('client_sessions')
      .where({ external_identity_id: id })
      .andWhere('absolute_expires_at', '>', db.fn.now())
      .whereNull('revoked_at')
      .select('id', 'session_public_key');
    res.json({
      invitePublicKey: identity.invite_public_key ?? null,
      sessions: sessions.map((s) => ({ id: s.id, publicKey: s.session_public_key })),
    });
  }),
);

// ---------- Staff "Invite a client" ----------
//
// Any active staff member can invite a client into a new secure conversation.
// Distinct from POST /admin/clients (admin-only CRUD) — this endpoint accepts
// the richer per-channel + verification payload from the Invite-a-client modal
// and is gated only by `client_messaging_enabled`. Returns the new identity's
// id and invitePublicKey so the client can immediately wrap a fresh
// conversation key to it (via the existing startExternalConversation path).

const inviteClientSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    channels: z.object({
      email: z
        .object({
          enabled: z.boolean(),
          value: z.string().email().max(255).optional().nullable(),
        })
        .default({ enabled: false, value: null }),
      sms: z
        .object({
          enabled: z.boolean(),
          // E.164: '+' then 7-15 digits. Client-side normalizes before submit.
          value: z
            .string()
            .regex(/^\+[1-9]\d{6,14}$/)
            .optional()
            .nullable(),
        })
        .default({ enabled: false, value: null }),
    }),
    verification: z.object({
      type: z.enum(['ssn', 'ein', 'none']),
      last4: z
        .string()
        .regex(/^\d{4}$/)
        .optional(),
      // null = never; undefined = fall back to firm default.
      reverifyEveryHours: z
        .union([z.literal(4), z.literal(8), z.literal(24), z.literal(168)])
        .nullable()
        .optional(),
    }),
    firmClientRef: z.string().trim().max(128).optional().nullable(),
  })
  .superRefine((v, ctx) => {
    const emailOk = v.channels.email.enabled && !!v.channels.email.value;
    const smsOk = v.channels.sms.enabled && !!v.channels.sms.value;
    if (!emailOk && !smsOk) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['channels'],
        message: 'at_least_one_channel_required',
      });
    }
    if ((v.verification.type === 'ssn' || v.verification.type === 'ein') && !v.verification.last4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verification', 'last4'],
        message: 'last4_required',
      });
    }
  });

clientsRouter.post(
  '/invite',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = inviteClientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }

    const settings = await db('firm_settings').where({ id: 1 }).first();
    if (!(settings?.client_messaging_enabled ?? true)) {
      res.status(403).json({ error: 'client_messaging_disabled' });
      return;
    }

    const displayName = parsed.data.displayName;
    const emailEnabled = parsed.data.channels.email.enabled;
    const smsEnabled = parsed.data.channels.sms.enabled;
    const email = emailEnabled ? parsed.data.channels.email.value!.trim().toLowerCase() : null;
    // Same canonicalisation as the create-client path so duplicate detection
    // and inbound-SMS lookup find the row regardless of how the admin typed it.
    const rawPhone = smsEnabled ? parsed.data.channels.sms.value! : null;
    const phone = rawPhone ? (normalizePhone(rawPhone) ?? null) : null;
    if (rawPhone && !phone) {
      res.status(400).json({ error: 'invalid_phone', detail: 'phone too short or malformed' });
      return;
    }

    // Duplicate detection — spec wants 409 with the existing id so the UI can
    // offer an "open existing conversation" path.
    if (email) {
      const existing = await db('external_identities').where({ email }).first();
      if (existing) {
        res.status(409).json({
          error: 'email_taken',
          existingId: existing.id,
          existingDisplayName: existing.display_name,
        });
        return;
      }
    }
    if (phone) {
      const existing = await db('external_identities').where({ phone }).first();
      if (existing) {
        res.status(409).json({
          error: 'phone_taken',
          existingId: existing.id,
          existingDisplayName: existing.display_name,
        });
        return;
      }
    }

    // STEPUP: bcrypt the last-4 at cost 10 (deliberately weaker than password
    // hashing because the input space is 10,000 and step-up checks need to be
    // fast). See vibe-connect-spec-invite-client.md § Human notes.
    let verificationLast4Hash: string | null = null;
    if (parsed.data.verification.type !== 'none') {
      verificationLast4Hash = await bcrypt.hash(parsed.data.verification.last4!, 10);
    }

    const invite = await generateInviteMaterial();
    // Primary channel — drives `invited_via` (surfaces in the sidebar's "Invited
    // 2h ago via email" label). Email wins when both are enabled because the
    // link is the same either way and email is generally more reliable.
    const primaryVia: 'email' | 'sms' = emailEnabled && email ? 'email' : 'sms';

    const preferences: Record<string, unknown> = {
      email_notifications: emailEnabled,
      sms_notifications: smsEnabled,
    };
    if (parsed.data.verification.reverifyEveryHours !== undefined) {
      preferences.reverify_every_hours = parsed.data.verification.reverifyEveryHours;
    }

    const firmClientRef = (parsed.data.firmClientRef ?? '').trim() || null;
    const [row] = await db('external_identities')
      .insert({
        // Same placeholder convention as /admin/clients so the unique index on
        // email stays happy when a client is SMS-only.
        email: email ?? `no-email-${randomBytes(4).toString('hex')}@placeholder.invalid`,
        phone,
        display_name: displayName,
        firm_client_ref: firmClientRef,
        verification_type: parsed.data.verification.type,
        verification_last4_hash: verificationLast4Hash,
        verification_required: parsed.data.verification.type !== 'none',
        preferences: JSON.stringify(preferences),
        invite_token_hash: invite.tokenHash,
        invite_public_key: invite.publicKey,
        invited_at: db.fn.now(),
        invited_via: primaryVia,
      })
      .returning(['id']);
    const identityId = (row as { id: string }).id;

    const actor = await db('users').where({ id: req.session.userId! }).first();
    const firmName = (settings?.firm_name as string | undefined) ?? null;
    const fromDisplayName = (actor?.display_name as string | undefined) ?? null;

    // Send to each enabled channel independently so a flaky SMS provider can't
    // stop the email going out (or vice versa). Invite material is already
    // persisted — staff can hit "Resend" from the admin UI if a channel fails.
    const deliveryStatus: { email: string | null; sms: string | null } = {
      email: null,
      sms: null,
    };
    const deliveryErrors: { email?: string; sms?: string } = {};

    if (emailEnabled && email) {
      try {
        await sendClientInvite({
          identityId,
          displayName,
          via: 'email',
          email,
          phone,
          token: invite.token,
          firmName,
          fromDisplayName,
        });
        deliveryStatus.email = 'sent';
      } catch (err) {
        deliveryStatus.email = 'failed';
        deliveryErrors.email = err instanceof Error ? err.message : String(err);
      }
    }
    if (smsEnabled && phone) {
      try {
        await sendClientInvite({
          identityId,
          displayName,
          via: 'sms',
          email,
          phone,
          token: invite.token,
          firmName,
          fromDisplayName,
        });
        deliveryStatus.sms = 'sent';
      } catch (err) {
        deliveryStatus.sms = 'failed';
        deliveryErrors.sms = err instanceof Error ? err.message : String(err);
      }
    }

    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'client.invited',
      targetType: 'external_identity',
      targetId: identityId,
      details: {
        channels: { email: emailEnabled, sms: smsEnabled },
        verificationType: parsed.data.verification.type,
        deliveryStatus,
        ...(Object.keys(deliveryErrors).length > 0 ? { deliveryErrors } : {}),
      },
    });

    res.status(201).json({
      externalIdentityId: identityId,
      invitePublicKey: invite.publicKey,
      deliveryStatus,
      ...(Object.keys(deliveryErrors).length > 0 ? { deliveryErrors } : {}),
    });
  }),
);

// ---------- Staff "Resend invite" ----------
//
// Sidebar pending-client flow. A staff member clicks an invited-but-not-activated
// client, corrects any typos in name / email / phone / verification, and resends
// the invite. This rotates the invite token + public key (same behaviour as the
// admin /admin/clients/:id/reinvite path) so a re-sent invite link always works.
//
// Only allowed while the client is still pending (last_active_at IS NULL and not
// deactivated) — once the client has signed in, their session public keys are in
// play and rotating invite_public_key would just strand any already-wrapped
// pre-activation drafts without helping. Admins can still re-issue via the
// /admin/clients/:id/reinvite path for activated clients if needed.
//
// `verification.last4` is optional on resend. If the caller omits it AND the
// verification type is unchanged, the existing hash is preserved. If the type
// changes to ssn/ein, last4 becomes required.
const resendInviteSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    channels: z.object({
      email: z
        .object({
          enabled: z.boolean(),
          value: z.string().email().max(255).optional().nullable(),
        })
        .default({ enabled: false, value: null }),
      sms: z
        .object({
          enabled: z.boolean(),
          value: z
            .string()
            .regex(/^\+[1-9]\d{6,14}$/)
            .optional()
            .nullable(),
        })
        .default({ enabled: false, value: null }),
    }),
    verification: z.object({
      type: z.enum(['ssn', 'ein', 'none']),
      last4: z
        .string()
        .regex(/^\d{4}$/)
        .optional(),
      reverifyEveryHours: z
        .union([z.literal(4), z.literal(8), z.literal(24), z.literal(168)])
        .nullable()
        .optional(),
    }),
    firmClientRef: z.string().trim().max(128).optional().nullable(),
  })
  .superRefine((v, ctx) => {
    const emailOk = v.channels.email.enabled && !!v.channels.email.value;
    const smsOk = v.channels.sms.enabled && !!v.channels.sms.value;
    if (!emailOk && !smsOk) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['channels'],
        message: 'at_least_one_channel_required',
      });
    }
  });

clientsRouter.post(
  '/:id([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/reinvite',
  requireAuth,
  asyncHandler(async (req, res) => {
    const identityId = req.params.id!;
    const current = await db('external_identities').where({ id: identityId }).first();
    if (!current || current.deactivated_at) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (current.last_active_at) {
      // Once a client has signed in, rotating the invite key would strand any
      // conversation wraps made to it without any benefit — the client uses
      // their active session keys now, not the invite key.
      res.status(409).json({ error: 'already_activated' });
      return;
    }

    const parsed = resendInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }

    const settings = await db('firm_settings').where({ id: 1 }).first();
    if (!(settings?.client_messaging_enabled ?? true)) {
      res.status(403).json({ error: 'client_messaging_disabled' });
      return;
    }

    const displayName = parsed.data.displayName;
    const emailEnabled = parsed.data.channels.email.enabled;
    const smsEnabled = parsed.data.channels.sms.enabled;
    const email = emailEnabled ? parsed.data.channels.email.value!.trim().toLowerCase() : null;
    const rawPhone = smsEnabled ? parsed.data.channels.sms.value! : null;
    const phone = rawPhone ? (normalizePhone(rawPhone) ?? null) : null;
    if (rawPhone && !phone) {
      res.status(400).json({ error: 'invalid_phone', detail: 'phone too short or malformed' });
      return;
    }

    // Duplicate detection — mirror /clients/invite semantics but exclude this
    // identity so resending unchanged contact info is allowed.
    if (email) {
      const existing = await db('external_identities')
        .where({ email })
        .andWhere('id', '!=', identityId)
        .first();
      if (existing) {
        res.status(409).json({
          error: 'email_taken',
          existingId: existing.id,
          existingDisplayName: existing.display_name,
        });
        return;
      }
    }
    if (phone) {
      const existing = await db('external_identities')
        .where({ phone })
        .andWhere('id', '!=', identityId)
        .first();
      if (existing) {
        res.status(409).json({
          error: 'phone_taken',
          existingId: existing.id,
          existingDisplayName: existing.display_name,
        });
        return;
      }
    }

    // Verification update rules:
    //   - Same type (ssn/ein), no new last4 → keep existing hash.
    //   - Same type (ssn/ein), new last4 → rehash.
    //   - Type changed to ssn/ein, new last4 → rehash.
    //   - Type changed to ssn/ein, no new last4 → 400.
    //   - Type changed to none → clear hash.
    const newType = parsed.data.verification.type;
    const currentType = current.verification_type as 'ssn' | 'ein' | 'none';
    let verificationLast4Hash: string | null =
      (current.verification_last4_hash as string | null) ?? null;
    if (newType === 'none') {
      verificationLast4Hash = null;
    } else if (parsed.data.verification.last4) {
      verificationLast4Hash = await bcrypt.hash(parsed.data.verification.last4, 10);
    } else if (newType !== currentType) {
      res.status(400).json({ error: 'last4_required' });
      return;
    }

    const invite = await generateInviteMaterial();
    const primaryVia: 'email' | 'sms' = emailEnabled && email ? 'email' : 'sms';

    const existingPrefs = (current.preferences as Record<string, unknown> | null | undefined) ?? {};
    const preferences: Record<string, unknown> = {
      ...existingPrefs,
      email_notifications: emailEnabled,
      sms_notifications: smsEnabled,
    };
    if (parsed.data.verification.reverifyEveryHours !== undefined) {
      preferences.reverify_every_hours = parsed.data.verification.reverifyEveryHours;
    }

    const firmClientRef =
      parsed.data.firmClientRef === undefined
        ? ((current.firm_client_ref as string | null) ?? null)
        : (parsed.data.firmClientRef ?? '').trim() || null;

    await db('external_identities')
      .where({ id: identityId })
      .update({
        email: email ?? `no-email-${randomBytes(4).toString('hex')}@placeholder.invalid`,
        phone,
        display_name: displayName,
        firm_client_ref: firmClientRef,
        verification_type: newType,
        verification_last4_hash: verificationLast4Hash,
        verification_required: newType !== 'none',
        preferences: JSON.stringify(preferences),
        invite_token_hash: invite.tokenHash,
        invite_public_key: invite.publicKey,
        invited_at: db.fn.now(),
        invited_via: primaryVia,
      });

    const actor = await db('users').where({ id: req.session.userId! }).first();
    const firmName = (settings?.firm_name as string | undefined) ?? null;
    const fromDisplayName = (actor?.display_name as string | undefined) ?? null;

    const deliveryStatus: { email: string | null; sms: string | null } = {
      email: null,
      sms: null,
    };
    const deliveryErrors: { email?: string; sms?: string } = {};

    if (emailEnabled && email) {
      try {
        await sendClientInvite({
          identityId,
          displayName,
          via: 'email',
          email,
          phone,
          token: invite.token,
          firmName,
          fromDisplayName,
        });
        deliveryStatus.email = 'sent';
      } catch (err) {
        deliveryStatus.email = 'failed';
        deliveryErrors.email = err instanceof Error ? err.message : String(err);
      }
    }
    if (smsEnabled && phone) {
      try {
        await sendClientInvite({
          identityId,
          displayName,
          via: 'sms',
          email,
          phone,
          token: invite.token,
          firmName,
          fromDisplayName,
        });
        deliveryStatus.sms = 'sent';
      } catch (err) {
        deliveryStatus.sms = 'failed';
        deliveryErrors.sms = err instanceof Error ? err.message : String(err);
      }
    }

    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'client.reinvited',
      targetType: 'external_identity',
      targetId: identityId,
      details: {
        channels: { email: emailEnabled, sms: smsEnabled },
        verificationType: newType,
        deliveryStatus,
        ...(Object.keys(deliveryErrors).length > 0 ? { deliveryErrors } : {}),
      },
    });

    res.status(200).json({
      externalIdentityId: identityId,
      invitePublicKey: invite.publicKey,
      deliveryStatus,
      ...(Object.keys(deliveryErrors).length > 0 ? { deliveryErrors } : {}),
    });
  }),
);
