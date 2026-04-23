// SMS bridge — inbound webhook for TextLink / Twilio / mock + opt-in/out + outbound send.
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { auditRepo } from '../repositories/audit.js';
import { logger } from '../logger.js';
import { publish } from '../realtime/pgFanout.js';
import { getSmsProvider } from '../bridges/sms/index.js';
import { sealPlaintextForBridge } from '../bridges/sealToFirm.js';

export const smsBridgeRouter = Router();

// Stop / start / unstop keyword handling
const STOP_WORDS = new Set(['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_WORDS = new Set(['START', 'UNSTOP', 'YES']);

smsBridgeRouter.post(
  '/sms-inbound',
  asyncHandler(async (req, res) => {
    const provider = getSmsProvider();
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
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
    if (
      !provider.verifyWebhookSignature({
        headers: req.headers as Record<string, string>,
        rawBody,
        url,
        params,
      })
    ) {
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
    const normalized = parsed.body.trim().toUpperCase();
    const identity = await db('external_identities').where({ phone: parsed.from }).first();
    if (!identity) {
      logger.warn('sms.unknown_number', { from: parsed.from });
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
      await getSmsProvider().sendMessage({
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
      await getSmsProvider().sendMessage({
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

    // Otherwise, treat as a message into the most recent external conversation this client
    // is a member of.
    const conv = await db('conversations as c')
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
  if (!args.urgent && (hour < 8 || hour >= 21)) return 'skipped-quiet';

  const settings = await db('firm_settings').where({ id: 1 }).first();
  const cap = Number(settings?.sms_monthly_cap ?? 1000);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const sentCount = await db('audit_log')
    .where({ action: 'sms.sent' })
    .andWhere('created_at', '>=', monthStart)
    .count<{ count: string }[]>('* as count');
  if (Number(sentCount[0]!.count) >= cap) return 'skipped-cap';

  await getSmsProvider().sendMessage({ to: identity.phone, body: args.body });
  await auditRepo.write({
    actorExternalIdentityId: identity.id,
    action: 'sms.sent',
    targetType: 'external_identity',
    targetId: identity.id,
  });
  return 'sent';
}
