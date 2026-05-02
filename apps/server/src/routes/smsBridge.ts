// SMS bridge — inbound webhook for TextLink / Twilio / mock + opt-in/out + outbound send.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { auditRepo } from '../repositories/audit.js';
import { logger } from '../logger.js';
import { publish } from '../realtime/pgFanout.js';
import { getSmsProvider } from '../bridges/sms/index.js';
import { sealPlaintextForBridge } from '../bridges/sealToFirm.js';
import { normalizePhone } from '../services/accessCodes.js';

export const smsBridgeRouter = Router();

// Stop / start / unstop keyword handling
const STOP_WORDS = new Set(['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_WORDS = new Set(['START', 'UNSTOP', 'YES']);

// BRIDGE: Twilio / TextLink signature verification already gates the endpoint,
// but a leaked signing key or spoofing issue could cause a surge. Defense in
// depth via per-IP rate limit.
const inboundLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.rateLimitSmsInboundPerMin,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

smsBridgeRouter.post(
  '/sms-inbound',
  inboundLimiter,
  asyncHandler(async (req, res) => {
    const provider = await getSmsProvider();
    // Prefer the raw request bytes captured in app.ts's JSON/urlencoded verify
    // hook. For providers that sign the raw payload (TextLink HMAC-SHA256),
    // serialising the already-parsed body via JSON.stringify would produce a
    // different byte sequence and the HMAC would mismatch. Fall back to
    // stringified body only for the mock provider in tests where no rawBody
    // capture ran.
    const capturedRaw = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const rawBody = capturedRaw
      ? capturedRaw.toString('utf8')
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body ?? {});
    // Twilio POSTs application/x-www-form-urlencoded; req.body is the parsed object.
    const params: Record<string, string> = {};
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
        if (typeof v === 'string') params[k] = v;
      }
    }
    const forwardedProto =
      (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ?? null;
    const proto = forwardedProto ?? req.protocol;
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.get('host') ?? '';
    const url = `${proto}://${host}${req.originalUrl}`;
    const verified = await provider.verifyWebhookSignature({
      headers: req.headers as Record<string, string>,
      rawBody,
      url,
      params,
    });
    if (!verified) {
      res.status(401).json({ error: 'bad_signature' });
      return;
    }
    const parsed = provider.parseInbound({
      body: req.body,
      headers: req.headers as Record<string, string>,
    });
    if (!parsed) {
      res.status(400).json({ error: 'bad_payload' });
      return;
    }
    // Anti-replay first. Providers retry on 5xx/timeouts; we want the retry
    // to be a no-op rather than causing an extra opt-out/opt-in confirmation
    // SMS or a duplicate stored message. Applies to ALL inbound branches
    // including STOP / START keywords (double-opt-out-confirm is spammy).
    if (parsed.providerMessageId) {
      const existing = await db('messages')
        .where({ source: 'sms-in' })
        .whereRaw(`source_meta->>'providerMessageId' = ?`, [parsed.providerMessageId])
        .first();
      if (existing) {
        logger.info('sms.inbound_dedup', { providerMessageId: parsed.providerMessageId });
        res.json({ ok: true });
        return;
      }
    }
    const normalized = parsed.body.trim().toUpperCase();
    // Honor STOP even when client messaging is disabled — opt-out is a TCPA
    // right. Everything else is blocked when the toggle is off.
    const settings = await db('firm_settings').where({ id: 1 }).first();
    const messagingEnabled = Boolean(settings?.client_messaging_enabled ?? true);
    // Defensive normalisation: Twilio already sends `+1...` and TextLink sends
    // `+<countrycode>...`, but any provider with a non-E.164 `from` field
    // would otherwise silently miss the row. normalizePhone returns the same
    // canonical form the admin-create path stored under.
    const fromNormalized = normalizePhone(parsed.from) ?? parsed.from;
    const identity = await db('external_identities').where({ phone: fromNormalized }).first();
    if (!identity) {
      logger.warn('sms.unknown_number', { from: parsed.from });
      res.json({ ok: true });
      return;
    }
    if (!messagingEnabled && !STOP_WORDS.has(normalized)) {
      await auditRepo.write({
        actorExternalIdentityId: identity.id,
        action: 'sms.inbound_blocked',
        targetType: 'sms',
        details: { reason: 'client_messaging_disabled' },
      });
      res.json({ ok: true });
      return;
    }

    if (STOP_WORDS.has(normalized)) {
      await db('sms_opt_ins')
        .insert({
          external_identity_id: identity.id,
          opted_in_at: new Date(0).toISOString(),
          opted_out_at: new Date().toISOString(),
          last_stop_keyword_at: new Date().toISOString(),
          provider: provider.name,
          source: 'inbound-stop',
        })
        .onConflict('external_identity_id')
        .merge({
          opted_out_at: new Date().toISOString(),
          last_stop_keyword_at: new Date().toISOString(),
          provider: provider.name,
        });
      await (
        await getSmsProvider()
      ).sendMessage({
        to: parsed.from,
        body: 'You have been opted out of messages from this firm. Reply START to re-enable.',
      });
      await auditRepo.write({
        actorExternalIdentityId: identity.id,
        action: 'sms.opt_out',
        targetType: 'external_identity',
        targetId: identity.id,
      });
      res.json({ ok: true });
      return;
    }

    if (START_WORDS.has(normalized)) {
      await db('sms_opt_ins')
        .insert({
          external_identity_id: identity.id,
          opted_in_at: new Date().toISOString(),
          provider: provider.name,
          source: 'inbound-start',
        })
        .onConflict('external_identity_id')
        .merge({
          opted_in_at: new Date().toISOString(),
          opted_out_at: null,
          provider: provider.name,
        });
      await (
        await getSmsProvider()
      ).sendMessage({
        to: parsed.from,
        body: 'Thanks — you are re-subscribed. Reply STOP at any time to stop.',
      });
      await auditRepo.write({
        actorExternalIdentityId: identity.id,
        action: 'sms.opt_in',
        targetType: 'external_identity',
        targetId: identity.id,
      });
      res.json({ ok: true });
      return;
    }

    // Routing: prefer the conversation where we most recently sent this
    // client an outbound SMS (within the last 24h). That matches the client's
    // mental model — "reply to the thing I was just texted about" — instead
    // of dumping replies into whichever conversation was most recently
    // touched by any staff activity. Falls back to most-recent-external if
    // no outbound exists or the hint points at a conversation the client is
    // no longer a member of.
    const OUTBOUND_HINT_WINDOW_HOURS = 24;
    // Postgres refuses a parameterised number inside an INTERVAL literal
    // ('? hours' can't be bound), so we embed the constant directly. It is
    // a compile-time number, not user input, so there's no injection risk.
    const hint = await db('audit_log')
      .where({ action: 'sms.sent', actor_external_identity_id: identity.id })
      .where('created_at', '>', db.raw(`NOW() - INTERVAL '${OUTBOUND_HINT_WINDOW_HOURS} hours'`))
      .orderBy('created_at', 'desc')
      .first();
    let hintedConvId: string | null = null;
    const details = hint?.details as { conversationId?: string } | null | undefined;
    if (details?.conversationId) {
      const hintMember = await db('conversations as c')
        .innerJoin('conversation_members as cm', 'cm.conversation_id', 'c.id')
        .where({
          'c.id': details.conversationId,
          'cm.external_identity_id': identity.id,
          'c.type': 'external',
        })
        .whereNull('cm.removed_at')
        .select('c.id')
        .first();
      if (hintMember) hintedConvId = hintMember.id as string;
    }
    const conv = hintedConvId
      ? { id: hintedConvId }
      : await db('conversations as c')
          .innerJoin('conversation_members as cm', 'cm.conversation_id', 'c.id')
          .where({ 'cm.external_identity_id': identity.id, 'c.type': 'external' })
          .whereNull('cm.removed_at')
          .orderBy('c.updated_at', 'desc')
          .select('c.id')
          .first();
    if (!conv) {
      res.json({ ok: true });
      return;
    }
    // BRIDGE: seal the SMS plaintext under the firm public key. See sealToFirm.ts.
    const sealed = await sealPlaintextForBridge(parsed.body);
    const [msg] = await db('messages')
      .insert({
        conversation_id: conv.id,
        sender_external_identity_id: identity.id,
        ciphertext: sealed,
        content_key_version: 0,
        source: 'sms-in',
        ciphertext_meta: { bridgePending: true, algorithm: 'bridge-sealed-v1' },
        source_meta: { providerMessageId: parsed.providerMessageId },
      })
      .returning(['id']);
    await db('conversations').where({ id: conv.id }).update({ updated_at: db.fn.now() });
    await auditRepo.write({
      actorExternalIdentityId: identity.id,
      action: 'sms.inbound_stored',
      targetType: 'message',
      targetId: msg!.id,
      details: { bridgePending: true },
    });
    await publish({
      type: 'message:new',
      conversationId: conv.id,
      messageId: msg!.id,
      senderId: null,
      senderExternalIdentityId: identity.id,
      urgent: false,
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  }),
);

// Outbound SMS — fires when staff → client message happens AND the client has opted in AND
// the recipient's timezone is not in quiet hours.
const outboundSchema = z.object({
  externalIdentityId: z.string().uuid(),
  body: z.string().max(480),
  urgent: z.boolean().default(false),
  // Threading the conversationId through lets inbound SMS routing pick the
  // right conversation when a client has several open with the firm — see
  // the audit-log lookup in sms-inbound handler.
  conversationId: z.string().uuid().optional(),
});

export async function maybeSendOutboundSms(
  args: z.infer<typeof outboundSchema>,
): Promise<'sent' | 'skipped-opt-out' | 'skipped-quiet' | 'skipped-cap'> {
  const identity = await db('external_identities').where({ id: args.externalIdentityId }).first();
  if (!identity?.phone) return 'skipped-opt-out';
  const optin = await db('sms_opt_ins').where({ external_identity_id: identity.id }).first();
  if (!optin || optin.opted_out_at) return 'skipped-opt-out';

  const tz = (identity.preferences as { timezone?: string } | null)?.timezone ?? 'UTC';
  const hour = Number(
    new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: tz }),
  );
  const settings = await db('firm_settings').where({ id: 1 }).first();
  // Firm-configurable quiet hours. TCPA default is 8-21; admins may tighten
  // (not relax) for compliance. `urgent=true` overrides — operators use this
  // sparingly for time-sensitive escalations per the build plan.
  const quietStart = Number(settings?.sms_quiet_start_hour ?? 8);
  const quietEnd = Number(settings?.sms_quiet_end_hour ?? 21);
  // Two window shapes:
  //   Normal window (start <= end, e.g. 8..21): quiet = outside [start, end).
  //   Wrap-around window (start > end, e.g. 22..6): quiet crosses midnight,
  //     so quiet = hour >= start OR hour < end (both halves of the night).
  // The pre-fix wrap-around branch had `hour < start && hour >= end`, which
  // is the inverse (the *awake* window), silently sending SMS at 3 AM on a
  // 22..6 quiet config while refusing to send at 5 PM.
  const inQuiet =
    quietStart <= quietEnd
      ? hour < quietStart || hour >= quietEnd
      : hour >= quietStart || hour < quietEnd;
  if (!args.urgent && inQuiet) return 'skipped-quiet';

  const cap = Number(settings?.sms_monthly_cap ?? 1000);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const sentCount = await db('audit_log')
    .where({ action: 'sms.sent' })
    .andWhere('created_at', '>=', monthStart)
    .count<{ count: string }[]>('* as count');
  if (Number(sentCount[0]!.count) >= cap) return 'skipped-cap';

  const smsProvider = await getSmsProvider();
  await smsProvider.sendMessage({ to: identity.phone, body: args.body });
  await auditRepo.write({
    actorExternalIdentityId: identity.id,
    action: 'sms.sent',
    targetType: 'external_identity',
    targetId: identity.id,
    details: args.conversationId ? { conversationId: args.conversationId } : undefined,
  });
  return 'sent';
}
