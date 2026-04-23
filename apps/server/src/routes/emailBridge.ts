// Email bridge — inbound + outbound.
// CRYPTO(BRIDGE): the plaintext-at-rest window is ONLY between webhook parse and the
// sealPlaintextForBridge call below. The sealed envelope is readable by holders of the
// recovery phrase (emergency decrypt) and will be re-wrapped under the conversation key
// on first staff-client access.
import crypto from 'node:crypto';
import { Router } from 'express';
import { simpleParser, type ParsedMail } from 'mailparser';
import EmailReplyParser from 'email-reply-parser';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { auditRepo } from '../repositories/audit.js';
import { logger } from '../logger.js';
import { publish } from '../realtime/pgFanout.js';
import { getEmailProvider } from '../bridges/email/index.js';
import { sealPlaintextForBridge } from '../bridges/sealToFirm.js';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../bridges/unsubscribeTokens.js';

export const emailBridgeRouter = Router();

// -------- Token issuance --------

export async function ensureConversationToken(conversationId: string): Promise<string> {
  const existing = await db('conversation_email_tokens')
    .where({ conversation_id: conversationId })
    .first();
  if (existing) return existing.token;
  const token = crypto.randomBytes(12).toString('base64url').slice(0, 16);
  await db('conversation_email_tokens').insert({
    conversation_id: conversationId,
    token,
  });
  return token;
}

export function makeInboundAddress(token: string): string {
  return `c+${token}@${env.emailInboundDomain}`;
}

// -------- Inbound webhook (Postmark format) --------

function verifyPostmarkSecret(req: {
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  // Fail-closed: if the provider is postmark and the secret is missing, reject.
  if (env.emailProvider === 'postmark' && !env.postmarkInboundWebhookSecret) {
    logger.error('email.postmark_webhook_secret_missing');
    return false;
  }
  if (!env.postmarkInboundWebhookSecret) {
    // Non-postmark deployment: still refuse unauthenticated hits in production.
    return !env.isProd;
  }
  const got = req.headers['x-postmark-webhook-secret'] as string | undefined;
  if (!got) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(got, 'utf8'),
      Buffer.from(env.postmarkInboundWebhookSecret, 'utf8'),
    );
  } catch {
    return false;
  }
}

emailBridgeRouter.post(
  '/email-inbound',
  asyncHandler(async (req, res) => {
    if (!verifyPostmarkSecret(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body = req.body as {
      From: string;
      To: string;
      Subject: string;
      TextBody: string;
      HtmlBody?: string;
      MessageID: string;
      Headers: Array<{ Name: string; Value: string }>;
      Attachments?: Array<{
        Name: string;
        ContentType: string;
        Content: string;
        ContentLength: number;
      }>;
    };
    if (!body?.From || !body?.To || !body?.TextBody) {
      res.status(400).json({ error: 'bad_payload' });
      return;
    }
    await processInbound({
      from: body.From,
      to: body.To,
      subject: body.Subject ?? '',
      text: body.TextBody,
      html: body.HtmlBody,
      messageId: body.MessageID,
      inReplyTo: body.Headers?.find((h) => h.Name.toLowerCase() === 'in-reply-to')?.Value,
      references: body.Headers?.find((h) => h.Name.toLowerCase() === 'references')?.Value,
      attachments: (body.Attachments ?? []).map((a) => ({
        name: a.Name,
        contentType: a.ContentType,
        contentBase64: a.Content,
      })),
    });
    res.json({ ok: true });
  }),
);

// -------- Raw MIME fallback (Postfix pipe) --------
// Shared-secret auth: the Postfix pipe script must pass the secret in x-vibe-bridge-secret.
// Reuses POSTMARK_INBOUND_WEBHOOK_SECRET as the appliance-wide bridge secret.

emailBridgeRouter.post(
  '/email-inbound-raw',
  asyncHandler(async (req, res) => {
    if (!env.postmarkInboundWebhookSecret) {
      logger.error('email.raw_endpoint_secret_missing');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const got = req.headers['x-vibe-bridge-secret'] as string | undefined;
    let ok = false;
    if (got) {
      try {
        ok = crypto.timingSafeEqual(
          Buffer.from(got, 'utf8'),
          Buffer.from(env.postmarkInboundWebhookSecret, 'utf8'),
        );
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const raw = typeof req.body === 'string' ? req.body : (req.body as { raw?: string }).raw;
    if (!raw) {
      res.status(400).json({ error: 'no_raw' });
      return;
    }
    const parsed: ParsedMail = await simpleParser(raw);
    await processInbound({
      from: (parsed.from?.value[0]?.address ?? '').toLowerCase(),
      to: parsed.to
        ? Array.isArray(parsed.to)
          ? parsed.to[0]!.value[0]!.address!
          : parsed.to.value[0]!.address!
        : '',
      subject: parsed.subject ?? '',
      text: parsed.text ?? '',
      html: typeof parsed.html === 'string' ? parsed.html : undefined,
      messageId: parsed.messageId ?? crypto.randomUUID(),
      inReplyTo: parsed.inReplyTo,
      references: Array.isArray(parsed.references)
        ? parsed.references.join(' ')
        : parsed.references,
      attachments: parsed.attachments.map((a) => ({
        name: a.filename ?? 'attachment',
        contentType: a.contentType,
        contentBase64: a.content.toString('base64'),
      })),
    });
    res.json({ ok: true });
  }),
);

interface InboundEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  attachments: Array<{ name: string; contentType: string; contentBase64: string }>;
}

async function processInbound(email: InboundEmail): Promise<void> {
  // Parse token from the To address: "c+<token>@connect.firmdomain"
  const match = email.to.match(/c\+([A-Za-z0-9_-]+)@/);
  if (!match) {
    logger.warn('email.no_token', { to: email.to });
    return;
  }
  const token = match[1]!;
  const link = await db('conversation_email_tokens').where({ token }).first();
  if (!link) {
    logger.warn('email.unknown_token', { token });
    return;
  }
  // Sender verification: from must match an external_identity already in the conversation.
  const from = email.from.toLowerCase().replace(/^.*<([^>]+)>.*$/, '$1');
  const identity = await db('external_identities').where({ email: from }).first();
  if (!identity) {
    await sendBounce(email.from, 'We could not match your email address to a contact on file.');
    return;
  }
  const member = await db('conversation_members')
    .where({ conversation_id: link.conversation_id, external_identity_id: identity.id })
    .whereNull('removed_at')
    .first();
  if (!member) {
    await sendBounce(email.from, 'You are not a member of that conversation.');
    return;
  }

  // Strip quoted tails + signatures with email-reply-parser.
  const reply = new EmailReplyParser();
  const cleaned = reply.read(email.text).getVisibleText();

  // BRIDGE: plaintext only exists on this line. sealPlaintextForBridge encrypts it under
  // a fresh symmetric key and wraps that key to the firm public key. Only a holder of the
  // recovery phrase (emergency_decrypt) can open this envelope until a staff client
  // rewraps it under the conversation key on first access. No plaintext at rest.
  const sealed = await sealPlaintextForBridge(cleaned);
  const [msg] = await db('messages')
    .insert({
      conversation_id: link.conversation_id,
      sender_external_identity_id: identity.id,
      ciphertext: sealed,
      content_key_version: 0, // special version = "awaiting rewrap under conversation key"
      source: 'email-in',
      ciphertext_meta: { bridgePending: true, algorithm: 'bridge-sealed-v1' },
      source_meta: {
        providerMessageId: email.messageId,
        subject: email.subject,
        inReplyTo: email.inReplyTo,
        references: email.references,
        attachments: email.attachments.map((a) => ({ name: a.name, mime: a.contentType })),
      },
    })
    .returning(['id']);

  await db('conversations').where({ id: link.conversation_id }).update({ updated_at: db.fn.now() });
  await auditRepo.write({
    actorExternalIdentityId: identity.id,
    action: 'email.inbound_stored',
    targetType: 'message',
    targetId: msg!.id,
    details: { bridgePending: true },
  });
  await publish({
    type: 'message:new',
    conversationId: link.conversation_id,
    messageId: msg!.id,
    senderId: null,
    senderExternalIdentityId: identity.id,
    urgent: false,
    createdAt: new Date().toISOString(),
  });
}

async function sendBounce(to: string, reason: string): Promise<void> {
  await getEmailProvider().send({
    to,
    subject: 'Your message could not be delivered',
    text: `We could not deliver your message: ${reason}\n\nIf this is a mistake, contact your firm.`,
  });
}

// -------- Outbound (notification-only, content mode controlled by firm settings) --------

const outboundSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  recipientExternalIdentityId: z.string().uuid(),
  previewCiphertext: z.string().optional(),
  urgent: z.boolean().default(false),
});

/** Called by the notification subsystem when a staff message to a client should trigger email. */
export async function maybeSendOutboundEmail(
  args: z.infer<typeof outboundSchema>,
): Promise<'sent' | 'rate-limited' | 'skipped-bounced' | 'skipped-unsubscribed'> {
  const settings = await db('firm_settings').where({ id: 1 }).first();
  const identity = await db('external_identities')
    .where({ id: args.recipientExternalIdentityId })
    .first();
  if (!identity || !settings) return 'skipped-unsubscribed';

  // Per-recipient rate-limit: max 3 notification emails per hour.
  const recent = await db('email_deliveries')
    .where({ recipient_external_identity_id: identity.id, status: 'sent' })
    .andWhere('created_at', '>', db.raw(`NOW() - INTERVAL '1 hour'`))
    .count<{ count: string }[]>('* as count');
  if (Number(recent[0]!.count) >= 3) return 'rate-limited';

  const prefs = (identity.preferences as { emailUnsubscribed?: boolean } | null) ?? {};
  if (prefs.emailUnsubscribed) return 'skipped-unsubscribed';

  // Check prior bounces; if the most recent delivery bounced, skip.
  const lastBounce = await db('email_deliveries')
    .where({ recipient_external_identity_id: identity.id, status: 'bounced' })
    .orderBy('created_at', 'desc')
    .first();
  const lastSent = await db('email_deliveries')
    .where({ recipient_external_identity_id: identity.id, status: 'sent' })
    .orderBy('created_at', 'desc')
    .first();
  if (lastBounce && (!lastSent || lastBounce.created_at > lastSent.created_at)) {
    return 'skipped-bounced';
  }

  const token = await ensureConversationToken(args.conversationId);
  const replyTo = makeInboundAddress(token);
  const portalUrl = env.portalUrl;

  if (settings.email_outbound_mode === 'content' && args.previewCiphertext) {
    logger.warn('email.content_mode_downgrade', { reason: 'no-server-decrypt' });
  }
  const subject = args.urgent ? `Urgent: new secure message` : `New secure message from your firm`;
  const signedUnsub = signUnsubscribeToken(identity.id);
  const unsubscribeLink = `${env.apiUrl}/bridges/unsubscribe?t=${encodeURIComponent(signedUnsub)}`;
  const result = await getEmailProvider().send({
    to: identity.email,
    subject,
    text:
      `You have a new secure message from your firm. Open it at ${portalUrl}\n\n` +
      `Reply-to address: ${replyTo}\n\n` +
      `To stop these notifications: ${unsubscribeLink}`,
    replyTo,
    headers: {
      'X-Vibe-Conversation': args.conversationId,
      'X-Vibe-Message': args.messageId,
      'List-Unsubscribe': `<${unsubscribeLink}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
  await db('email_deliveries').insert({
    message_id: args.messageId,
    recipient_external_identity_id: identity.id,
    provider_id: result.id,
    status: 'sent',
    details: { urgent: args.urgent },
  });
  return 'sent';
}

// -------- Unsubscribe endpoint --------

emailBridgeRouter.get(
  '/unsubscribe',
  asyncHandler(async (req, res) => {
    const t = String(req.query.t ?? '');
    if (!t) {
      res.status(400).send('Missing token');
      return;
    }
    const identityId = verifyUnsubscribeToken(t);
    if (!identityId) {
      res.status(400).send('Invalid unsubscribe link.');
      return;
    }
    const id = await db('external_identities').where({ id: identityId }).first();
    if (id) {
      const prefs = { ...(id.preferences ?? {}), emailUnsubscribed: true };
      await db('external_identities').where({ id: identityId }).update({ preferences: prefs });
      await auditRepo.write({
        actorExternalIdentityId: identityId,
        action: 'email.unsubscribed',
        targetType: 'external_identity',
        targetId: identityId,
      });
    }
    res.send('You have been unsubscribed. Messages sent inside the portal remain available.');
  }),
);

// -------- Delivery webhook (Postmark) --------

emailBridgeRouter.post(
  '/email-events',
  asyncHandler(async (req, res) => {
    if (!verifyPostmarkSecret(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body = req.body as {
      MessageID?: string;
      RecordType?: string;
      Type?: string;
    };
    const providerId = body.MessageID;
    if (!providerId) {
      res.json({ ok: true });
      return;
    }
    const rec = body.RecordType?.toLowerCase() ?? body.Type?.toLowerCase() ?? 'unknown';
    const status =
      rec === 'bounce' || rec === 'spamcomplaint'
        ? 'bounced'
        : rec === 'delivery'
          ? 'delivered'
          : rec;
    await db('email_deliveries')
      .where({ provider_id: providerId })
      .update({ status, updated_at: db.fn.now() });
    res.json({ ok: true });
  }),
);
