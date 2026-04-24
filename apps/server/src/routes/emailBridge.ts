// Email bridge — inbound + outbound.
// CRYPTO(BRIDGE): the plaintext-at-rest window is ONLY between webhook parse and the
// sealPlaintextForBridge call below. The sealed envelope is readable by holders of the
// recovery phrase (emergency decrypt) and will be re-wrapped under the conversation key
// on first staff-client access.
import crypto, { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
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
import { sealBytesForBridge, sealPlaintextForBridge } from '../bridges/sealToFirm.js';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../bridges/unsubscribeTokens.js';
import { attachmentStorage } from '../services/attachmentStorage.js';
import { attachmentsRepo } from '../repositories/messages.js';
import { scanBuffer } from '../services/clamav.js';

export const emailBridgeRouter = Router();

// BRIDGE: shared-secret auth keeps random callers out, but a leaked secret or
// a misbehaving provider could flood the appliance. Cap per source IP as
// defense in depth. Postmark normally delivers from a small set of IPs, so a
// 200/min cap won't trip on legitimate traffic.
const inboundLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.rateLimitEmailInboundPerMin,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

// -------- Token issuance --------

export async function ensureConversationToken(conversationId: string): Promise<string> {
  const existing = await db('conversation_email_tokens')
    .where({ conversation_id: conversationId })
    .first();
  if (existing) return existing.token;
  // Lowercase hex: 64 bits of entropy in 16 chars (astronomically unguessable)
  // and — importantly — case-insensitive-friendly. Email local parts get
  // lowercased in transit by many MTAs including Postmark; a mixed-case
  // base64url token would fail the post-lowercase lookup in processInbound.
  // Using hex sidesteps that class of bug entirely.
  const token = crypto.randomBytes(8).toString('hex');
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

async function verifyPostmarkSecret(req: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<boolean> {
  // The mock provider writes outbound messages to .outbox/ and doesn't take
  // inbound webhooks from the internet, so the secret is optional there.
  // Every other provider (postmark, postfix) carries a real delivery path,
  // so the secret is required regardless of NODE_ENV — a staging instance
  // with accidental internet exposure must not accept unauthenticated
  // inbound webhooks just because isProd happens to be false.
  const mockOnly = env.emailProvider === 'mock';
  const { getOrEnvFallback } = await import('../services/providerSecrets.js');
  const expected = await getOrEnvFallback(
    'email.postmark.inbound_webhook_secret',
    env.postmarkInboundWebhookSecret,
  );
  if (!expected) {
    if (mockOnly) return true;
    logger.error('email.webhook_secret_missing', { provider: env.emailProvider });
    return false;
  }
  const got = req.headers['x-postmark-webhook-secret'] as string | undefined;
  if (!got) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

emailBridgeRouter.post(
  '/email-inbound',
  inboundLimiter,
  asyncHandler(async (req, res) => {
    if (!(await verifyPostmarkSecret(req))) {
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
  inboundLimiter,
  asyncHandler(async (req, res) => {
    // Dedicated secret so a leaked Postmark secret doesn't also open the raw
    // endpoint. Falls back to the Postmark secret during rollout — see env.ts
    // for the compatibility note.
    const rawBridgeSecret = env.postfixRawBridgeSecret || env.postmarkInboundWebhookSecret;
    if (!rawBridgeSecret) {
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
          Buffer.from(rawBridgeSecret, 'utf8'),
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
  // Sanitised form of the providerMessageId — used for BOTH the dedup lookup
  // and the eventual store. Without this the dedup lookup (raw value) would
  // never match the store (sanitised value) for any MessageID with control
  // chars, and a hostile sender could bypass dedup by inserting a stray
  // newline.
  // eslint-disable-next-line no-control-regex
  const providerMessageId = (email.messageId ?? '').replace(/[\u0000-\u001F\u007F]+/g, '?').slice(0, 255);
  // Anti-replay first. Providers retry webhooks on receiver timeouts, and a
  // duplicate delivery at this layer would otherwise cost us an extra bounce
  // (for sendBounce branches below), an extra audit row, or — worst case — a
  // duplicate message insert if the retry races with a slow first pass. The
  // dedup lookup is cheap (indexed jsonb expression) and MUST run before any
  // outbound action so retries stay idempotent.
  if (providerMessageId) {
    const existing = await db('messages')
      .where({ source: 'email-in' })
      .whereRaw(`source_meta->>'providerMessageId' = ?`, [providerMessageId])
      .first();
    if (existing) {
      logger.info('email.inbound_dedup', { providerMessageId });
      return;
    }
  }
  // Firm-wide kill switch. When disabled we bounce with a neutral reason and
  // audit the drop, but do NOT store the ciphertext — the whole point of the
  // toggle is to stop accumulating client content during an outage / incident.
  const settings = await db('firm_settings').where({ id: 1 }).first();
  if (!(settings?.client_messaging_enabled ?? true)) {
    await sendBounce(
      email.from,
      'Client messaging is temporarily disabled by your firm. Please contact them directly.',
    );
    await auditRepo.write({
      action: 'email.inbound_blocked',
      targetType: 'email',
      details: { reason: 'client_messaging_disabled', from: email.from },
    });
    return;
  }
  // Parse token from the To address: "c+<token>@connect.firmdomain".
  // Anchored match on the local-part start so an address like
  // `noreply+c+attackertoken@...` or a mixed-recipient header can't plant a
  // phantom `c+` somewhere other than position 0 and get treated as the
  // conversation routing key. A leading angle bracket is allowed because some
  // providers hand us `<c+token@...>` rather than a bare address.
  const addr = email.to.trim().replace(/^</, '').toLowerCase();
  const match = addr.match(/^c\+([A-Za-z0-9_-]+)@/);
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
  // Sanitise attacker-supplied text fields before persisting into source_meta.
  // Control chars + length caps stop a hostile sender from smuggling newlines
  // or huge strings into structured logs + admin UI that may render them
  // without re-escaping.
  const sanitize = (s: string | undefined, max: number): string =>
    // eslint-disable-next-line no-control-regex
    (s ?? '').replace(/[\u0000-\u001F\u007F]+/g, '?').slice(0, max);
  const [msg] = await db('messages')
    .insert({
      conversation_id: link.conversation_id,
      sender_external_identity_id: identity.id,
      ciphertext: sealed,
      content_key_version: 0, // special version = "awaiting rewrap under conversation key"
      source: 'email-in',
      ciphertext_meta: { bridgePending: true, algorithm: 'bridge-sealed-v1' },
      source_meta: {
        providerMessageId, // already sanitised at the top of processInbound
        subject: sanitize(email.subject, 512),
        inReplyTo: sanitize(email.inReplyTo, 255),
        references: sanitize(email.references, 2048),
        attachments: email.attachments.map((a) => ({
          name: sanitize(a.name, 255),
          mime: sanitize(a.contentType, 128),
        })),
      },
    })
    .returning(['id']);

  // BRIDGE: persist inbound attachments. Each file is sealed-to-firm (same envelope
  // format as the body) and stored via the regular attachment driver. The filename
  // ciphertext also goes through sealPlaintextForBridge so staff can recover the
  // original name after the first rewrap. `wrapped_file_key` is empty bytes at
  // bridge-pending stage — the rewrap pass (future phase) swaps it for a real
  // per-conversation-key wrap. scan_status defers to clamd; unscanned bytes never
  // reach the download endpoint because it gates on scan_status === 'clean'.
  const store = attachmentStorage();
  for (const a of email.attachments) {
    try {
      const rawBytes = Buffer.from(a.contentBase64, 'base64');
      if (rawBytes.byteLength === 0) continue;
      if (rawBytes.byteLength > env.attachmentMaxBytes) {
        logger.warn('email.attachment_oversize_skipped', {
          name: a.name,
          size: rawBytes.byteLength,
        });
        continue;
      }
      // Scan FIRST. The pre-fix order was scan → seal → store → (if infected) delete,
      // which wrote the sealed ciphertext to disk for every message — including
      // malicious ones — and relied on the delete path to clean up. Any
      // transient storage failure on the delete leg produced orphan blobs with
      // no DB row pointing at them. Checking scan up-front means we never
      // touch the storage driver for infected bytes.
      const scan = await scanBuffer(rawBytes);
      // Safe-filename copy for audit: strip control chars (U+0000..U+001F
      // plus DEL U+007F) + length-cap so a hostile sender can't inject
      // newlines or arbitrary bytes into our structured logs and audit
      // details (admin UI / log aggregators may not re-escape). The initial
      // form of this regex was [ -]+ (a range from U+0020 space to U+002D
      // hyphen) which incorrectly stripped ordinary punctuation and
      // corrupted every filename with a dot or dash.
      // eslint-disable-next-line no-control-regex
      const safeName = a.name.replace(/[\u0000-\u001F\u007F]+/g, '?').slice(0, 255);
      // Sanitise mime at the same time so a spoofed `text/html; ...` stored on
      // the attachments row can't confuse downstream consumers.
      // eslint-disable-next-line no-control-regex
      const safeMime = a.contentType.replace(/[\u0000-\u001F\u007F]+/g, '').slice(0, 128);
      if (scan.status === 'infected') {
        const sealedFilename = await sealPlaintextForBridge(safeName);
        await attachmentsRepo.insert({
          message_id: msg!.id,
          filename_ciphertext: sealedFilename.toString('base64'),
          mime_type: safeMime,
          size_bytes: rawBytes.byteLength,
          storage_path: '',
          wrapped_file_key: Buffer.alloc(0),
          scan_status: 'infected',
          envelope_format: 'bridge-sealed-v1',
        });
        await auditRepo.write({
          action: 'email.inbound_attachment_infected',
          targetType: 'attachment',
          targetId: msg!.id,
          details: { signature: scan.signature, name: safeName },
        });
        continue;
      }
      if (scan.status === 'error') {
        // clamd unreachable. The staff and portal upload paths fail-closed with
        // a 503 so the client retries; we can't ask the email sender to retry,
        // so the choice is accept-as-pending or drop. We drop: the email was
        // delivered to the bridge but the attachment didn't clear AV, so we
        // audit-record a "stripped" row (no storage blob, no filename stored
        // even encrypted) and move on. Staff sees the stripped audit row if
        // they need to ask the sender to re-send. This matches the "fail-
        // closed during clamd outage" stance used elsewhere.
        logger.warn('email.attachment_scan_unavailable', {
          messageId: msg!.id,
          name: safeName,
          scan: scan.message,
        });
        await auditRepo.write({
          action: 'email.inbound_attachment_scan_unavailable',
          targetType: 'message',
          targetId: msg!.id,
          details: { name: safeName, size: rawBytes.byteLength, scan: scan.message },
        });
        continue;
      }
      // Clean. Seal the body and filename, store the blob, and insert the row.
      // Keep this order (seal → store → insert) so a DB failure between store
      // and insert leaves an orphan blob that can be swept by a future ops
      // job but doesn't end up with a half-authored row.
      //
      // Use sealBytesForBridge for the body — passing raw bytes avoids the
      // base64 round-trip that sealPlaintextForBridge does (which inflates
      // each attachment by ~33% before encryption).
      const sealedBody = await sealBytesForBridge(rawBytes);
      const sealedFilename = await sealPlaintextForBridge(safeName);
      const storageKey = await store.put(
        `bridge-${msg!.id}-${Date.now()}-${randomBytes(8).toString('hex')}.bin`,
        sealedBody,
      );
      try {
        await attachmentsRepo.insert({
          message_id: msg!.id,
          filename_ciphertext: sealedFilename.toString('base64'),
          mime_type: safeMime,
          size_bytes: rawBytes.byteLength,
          storage_path: storageKey,
          wrapped_file_key: Buffer.alloc(0),
          scan_status: 'clean',
          envelope_format: 'bridge-sealed-v1',
        });
      } catch (insertErr) {
        // Row insert failed after blob was stored. Best-effort cleanup of the
        // orphan blob so a future retention sweep doesn't have to.
        try {
          await store.delete(storageKey);
        } catch {
          /* already logged below via insertErr; swallow */
        }
        throw insertErr;
      }
    } catch (err) {
      logger.warn('email.inbound_attachment_failed', {
        name: a.name,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await db('conversations').where({ id: link.conversation_id }).update({ updated_at: db.fn.now() });
  await auditRepo.write({
    actorExternalIdentityId: identity.id,
    action: 'email.inbound_stored',
    targetType: 'message',
    targetId: msg!.id,
    details: { bridgePending: true, attachmentCount: email.attachments.length },
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
  const provider = await getEmailProvider();
  await provider.send({
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
  const signedUnsub = await signUnsubscribeToken(identity.id);
  const unsubscribeLink = `${env.apiUrl}/bridges/unsubscribe?t=${encodeURIComponent(signedUnsub)}`;
  const emailProvider = await getEmailProvider();
  const result = await emailProvider.send({
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
//
// Shared handler for GET (user click from email) and POST (RFC 8058 one-click
// from mailbox providers like Gmail / Apple Mail). Both paths take the token
// out of `?t=`; POST additionally accepts `List-Unsubscribe=One-Click` in the
// form body per the spec. We accept the link regardless of body for resilience
// — the provider's intent is unambiguous once the signed token validates.
async function handleUnsubscribe(t: string, req: Request, res: Response): Promise<void> {
  if (!t) {
    res.status(400).send('Missing token');
    return;
  }
  const identityId = await verifyUnsubscribeToken(t);
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
      details: { method: req.method },
    });
  }
  res.send('You have been unsubscribed. Messages sent inside the portal remain available.');
}

emailBridgeRouter.get(
  '/unsubscribe',
  asyncHandler(async (req, res) => {
    await handleUnsubscribe(String(req.query.t ?? ''), req, res);
  }),
);

// RFC 8058 one-click: mailbox providers POST here with the signed token in the
// query string (same URL they found in the List-Unsubscribe header). Some
// clients additionally send `List-Unsubscribe=One-Click` in an
// x-www-form-urlencoded body; we ignore the body shape and rely on the signed
// token since that's the verified credential.
emailBridgeRouter.post(
  '/unsubscribe',
  asyncHandler(async (req, res) => {
    const fromQuery = String(req.query.t ?? '');
    const bodyT =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? String((req.body as { t?: unknown }).t ?? '')
        : '';
    await handleUnsubscribe(fromQuery || bodyT, req, res);
  }),
);

// -------- Delivery webhook (Postmark) --------

emailBridgeRouter.post(
  '/email-events',
  asyncHandler(async (req, res) => {
    if (!(await verifyPostmarkSecret(req))) {
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
