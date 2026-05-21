// Email provider interface + mock + Postmark + Postfix-SMTP implementations.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { getOrEnvFallback } from '../../services/providerSecrets.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  replyTo?: string;
}

// Single timeout used by every HTTP-based provider. 15s comfortably covers
// the p99 of Postmark / Emailit / Twilio while still letting a stuck send
// surface as a logged failure rather than blocking a ticker tick forever.
const PROVIDER_TIMEOUT_MS = 15_000;

// Hard-cap + best-effort redact for provider error bodies before they
// flow into thrown errors. The contiguous-alnum pattern catches dash-free
// tokens (Twilio Account SIDs, hex API keys, base64 secrets) without
// shredding UUID-shaped correlation IDs (which contain dashes — operators
// need them visible to file support tickets).
function redactAndCap(raw: string): string {
  const redacted = raw.replace(/[A-Za-z0-9_]{20,}/g, '[redacted]');
  // 160 chars keeps the toast on one or two lines and bounds the audit
  // detail size — operators who need the full payload have it in the
  // warn log emitted by the provider call site.
  return redacted.length > 160 ? `${redacted.slice(0, 160)}…` : redacted;
}

function mapFetchError(provider: string, err: unknown): Error {
  const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
  if (isTimeout) return new Error(`${provider}_timeout_after_${PROVIDER_TIMEOUT_MS}ms`);
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${provider}_network_error: ${msg.slice(0, 120)}`);
}

// Single chokepoint for outbound recipient cleanup. Trims whitespace and
// lowercases so a stray trailing space (common when callers pluck the
// value off a CSV row or copy-pasted onboarding sheet) doesn't hit
// Postmark / Emailit as a 422 "invalid recipient". RFC 5321 says the
// local part is technically case-sensitive, but every consumer mailbox
// provider treats it case-insensitively, and our own DB lookups already
// lowercase — keeping the wire form consistent with that.
//
// Throws on empty input so a programmer error (caller passed `undefined`
// or `""`) surfaces as a clear typed error instead of an opaque 4xx from
// the provider. The provider impl below also re-validates From; together
// these two checks turn "mysterious 422 from Postmark" into a self-
// describing throw the Admin → Providers UI can render verbatim.
function normalizeRecipient(raw: string): string {
  const cleaned = (raw ?? '').trim().toLowerCase();
  if (!cleaned) throw new Error('email_to_missing');
  if (!cleaned.includes('@')) throw new Error('email_to_invalid');
  return cleaned;
}

// Resolve the From address with the same DB → env precedence used by the
// rest of the provider settings (firm_settings.email_provider,
// firm_provider_credentials). DB value (firm_settings.email_from) wins
// so an operator can fix a misconfigured sender from Admin → Providers
// without an env edit + restart; env is the fallback for pre-migration
// installs that already had EMAIL_FROM set.
//
// Validates that whatever we resolve is not the bundled placeholder
// `vibeconnect.local`, which a real provider (Postmark / Emailit) WILL
// reject because that domain is reserved-but-unregistered and therefore
// can never be a verified sender. Most "no email arriving" tickets in
// the field trace back to an operator shipping with the placeholder
// still in place. Refuse early with a message that names BOTH locations
// (DB-first, env-fallback) instead of letting the provider return a
// generic 422.
//
// Postfix is exempt from the placeholder check because SMTP relays can
// be configured to rewrite or accept arbitrary From addresses depending
// on the operator's setup — the placeholder will still typically fail
// downstream there, but we don't want to second-guess a working relay.
async function resolveEmailFrom(providerKind: 'postmark' | 'emailit' | 'postfix'): Promise<string> {
  let dbValue: string | null = null;
  try {
    const { db } = await import('../../db/knex.js');
    const row = await db('firm_settings').where({ id: 1 }).first('email_from');
    const raw = row?.email_from;
    if (typeof raw === 'string' && raw.trim()) dbValue = raw.trim();
  } catch (err) {
    // DB unreachable at send time — fall through to env. Same posture as
    // resolveEmailProviderKind below: don't let a maintenance window
    // break outbound mail when env already has a working value.
    logger.warn('email_from_db_lookup_failed', {
      msg: err instanceof Error ? err.message : String(err),
    });
  }
  const from = (dbValue ?? env.emailFrom ?? '').trim();
  if (!from) {
    throw new Error(
      'email_from_not_configured: no sender address set. Configure it in Admin → Providers → Sender address, or set EMAIL_FROM in the appliance env.',
    );
  }
  if (providerKind !== 'postfix' && /vibeconnect\.local/i.test(from)) {
    throw new Error(
      'email_from_placeholder: sender address is still the bundled placeholder (noreply@vibeconnect.local). Set Admin → Providers → Sender address to an address whose sending domain you have verified on your email provider.',
    );
  }
  return from;
}

export interface EmailProvider {
  send(msg: EmailMessage): Promise<{ id: string; status: 'sent' | 'queued' | 'bounced' }>;
  name: string;
}

class MockProvider implements EmailProvider {
  name = 'mock';
  async send(msg: EmailMessage) {
    // Normalize even in mock so the .outbox/ artefact matches what a real
    // provider would receive — makes dev/test inspection less surprising
    // and catches `to: undefined` programmer errors here too.
    const to = normalizeRecipient(msg.to);
    const outbox = path.resolve(env.outboxDir, 'email');
    await fs.mkdir(outbox, { recursive: true });
    const id = `mock-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const file = path.join(outbox, `${id}.json`);
    await fs.writeFile(
      file,
      JSON.stringify({ ...msg, to, id, at: new Date().toISOString() }, null, 2),
    );
    logger.info('email.mock_sent', { file, to, subject: msg.subject });
    return { id, status: 'sent' as const };
  }
}

// Explicit "outbound mail disabled" provider. Returns success so caller
// branches that catch send-errors stay on the silent-success path (the
// portal /identify route requires that the response shape be
// indistinguishable across configured / unconfigured providers, so an
// access-code request never leaks whether the firm has working email).
// One structured warn-log per send so operators inspecting `docker logs`
// can see the disabled state instead of wondering why mail isn't arriving.
class NoneProvider implements EmailProvider {
  name = 'none';
  async send(msg: EmailMessage) {
    // Normalize so the warn log is consistent across providers. Skip the
    // From validation — `none` is the explicit "outbound mail disabled"
    // mode and operators shouldn't need a valid EMAIL_FROM just to keep
    // unrelated callers (e.g. the portal /identify swallowing path) from
    // crashing.
    const to = normalizeRecipient(msg.to);
    logger.warn('email.disabled_send_skipped', {
      to,
      subject: msg.subject,
      hint: 'EMAIL_PROVIDER=none — set EMAIL_PROVIDER and provider credentials to enable outbound mail.',
    });
    return { id: `none-${Date.now()}`, status: 'sent' as const };
  }
}

class PostmarkProvider implements EmailProvider {
  name = 'postmark';
  async send(msg: EmailMessage) {
    const from = await resolveEmailFrom('postmark');
    const to = normalizeRecipient(msg.to);
    const token = await getOrEnvFallback('email.postmark.server_token', env.postmarkServerToken);
    if (!token) throw new Error('postmark_token_not_configured');
    const body = {
      From: from,
      To: to,
      Subject: msg.subject,
      TextBody: msg.text,
      HtmlBody: msg.html,
      Headers: Object.entries(msg.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
      ReplyTo: msg.replyTo,
      MessageStream: 'outbound',
    };
    let res: Response;
    try {
      res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Postmark-Server-Token': token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (err) {
      throw mapFetchError('postmark', err);
    }
    if (!res.ok) {
      // Postmark returns the token in error replies for some 4xx cases. We
      // log the full body at warn level so operators tailing docker logs
      // can see correlation IDs / Postmark error codes, then bubble a hard
      // -capped + redacted form upward (audit + UI toast).
      const full = await res.text();
      logger.warn('email.postmark_send_failed', { status: res.status, body: full.slice(0, 500) });
      throw new Error(`postmark_${res.status}: ${redactAndCap(full)}`);
    }
    const data = (await res.json()) as { MessageID: string };
    return { id: data.MessageID, status: 'sent' as const };
  }
}

// Emailit v2 transactional API.
//   Endpoint:        POST https://api.emailit.com/v2/emails
//   Auth:            Authorization: Bearer <api_key>
//   Content-Type:    application/json
//   Idempotency-Key: optional, dedups for 24h
//   Required body:   from (RFC 5322 string), to (string | string[]),
//                    subject (unless template), html OR text
//   Optional body:   reply_to, cc, bcc, headers, meta, attachments,
//                    template+variables, scheduled_at, tracking
//   Spec reference:  https://emailit.com/docs/api-reference/emails/send/
//
// Common failure mode operators hit on first integration: Emailit
// rejects sends from sender-domains that aren't verified on their
// account. Symptom is a 422 with `{ "message": "Sender domain not
// verified ..." }`. The error-extraction below surfaces that string
// directly so the Admin → Providers Test button shows the real reason
// instead of a generic emailit_422.
const DEFAULT_EMAILIT_BASE_URL = 'https://api.emailit.com/v2';

/**
 * Pull the human-readable error string out of Emailit's JSON error
 * response, with graceful fallback to the raw body if parsing fails.
 * Response shape per spec: { error, message, details?, validation_errors? }.
 */
function extractEmailitError(rawBody: string): string {
  if (!rawBody) return '<empty body>';
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: unknown;
      message?: unknown;
      details?: unknown;
      validation_errors?: unknown;
    };
    // `message` is the friendly description; `error` is the type/title.
    // `validation_errors` carries field-level reasons. Stitch them.
    const parts: string[] = [];
    if (typeof parsed.message === 'string' && parsed.message.trim()) parts.push(parsed.message);
    else if (typeof parsed.error === 'string' && parsed.error.trim()) parts.push(parsed.error);
    if (Array.isArray(parsed.validation_errors) && parsed.validation_errors.length > 0) {
      const fieldMsgs = parsed.validation_errors
        .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
        .filter((s) => s.length > 0)
        .join('; ');
      if (fieldMsgs) parts.push(`(${fieldMsgs})`);
    }
    if (parts.length > 0) return parts.join(' ');
  } catch {
    // Not JSON — fall through to the raw redacted body.
  }
  return redactAndCap(rawBody);
}

class EmailitProvider implements EmailProvider {
  name = 'emailit';
  async send(msg: EmailMessage) {
    const from = await resolveEmailFrom('emailit');
    const to = normalizeRecipient(msg.to);
    const apiKey = await getOrEnvFallback('email.emailit.api_key', env.emailitApiKey);
    if (!apiKey) throw new Error('emailit_api_key_not_configured');
    const baseRaw =
      (await getOrEnvFallback('email.emailit.base_url', env.emailitBaseUrl)) ??
      DEFAULT_EMAILIT_BASE_URL;
    const base = baseRaw.replace(/\/+$/, '');
    const replyTo =
      msg.replyTo ??
      (await getOrEnvFallback('email.emailit.reply_to', env.emailitReplyTo)) ??
      undefined;
    // The API wants the From in RFC 5322 form. env.emailFrom may already be
    // "Name <email>" (the default) or a bare address — either way we hand
    // it through as a string.
    const body = {
      from,
      to,
      subject: msg.subject,
      // `text` is optional; `html` is required only when neither template
      // nor `text` is present. We always pass `text`, and only include
      // `html` when the caller supplied one — Emailit accepts text-only.
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(msg.headers && Object.keys(msg.headers).length > 0 ? { headers: msg.headers } : {}),
    };
    // Idempotency-Key shields a flaky-network retry from creating a
    // duplicate send. Emailit dedups by key for 24h. Random per request
    // (we don't want two distinct sends to share a key).
    const idempotencyKey = randomUUID();
    let res: Response;
    try {
      res = await fetch(`${base}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (err) {
      throw mapFetchError('emailit', err);
    }
    if (!res.ok) {
      const full = await res.text();
      logger.warn('email.emailit_send_failed', {
        status: res.status,
        body: full.slice(0, 500),
        idempotencyKey,
      });
      throw new Error(`emailit_${res.status}: ${extractEmailitError(full)}`);
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    const pick = (v: unknown, k: string): string | null => {
      if (!v || typeof v !== 'object') return null;
      const x = (v as Record<string, unknown>)[k];
      return typeof x === 'string' ? x : null;
    };
    const id =
      pick(parsed, 'id') ??
      pick(parsed, 'message_id') ??
      pick((parsed as { data?: unknown } | null)?.data, 'id') ??
      `emailit-${Date.now()}`;
    logger.info('email.emailit_sent', { to, id, idempotencyKey });
    return { id, status: 'sent' as const };
  }
}

class PostfixProvider implements EmailProvider {
  name = 'postfix';
  // Transport is re-resolved per-send so rotating SMTP settings in the admin
  // UI takes effect on the next message instead of requiring a restart.
  // nodemailer caches the socket internally via its own pool; the per-send
  // create is cheap.
  private async buildTransport(): Promise<Transporter> {
    const host = await getOrEnvFallback('email.smtp.host', env.smtpHost);
    if (!host) throw new Error('SMTP_HOST is required when EMAIL_PROVIDER=postfix');
    const portStr = await getOrEnvFallback('email.smtp.port', String(env.smtpPort));
    const port = portStr ? Number(portStr) : env.smtpPort;
    const secureFlag = await getOrEnvFallback('email.smtp.secure', env.smtpSecure ? '1' : '0');
    const secure = secureFlag === '1' || secureFlag === 'true';
    const user = await getOrEnvFallback('email.smtp.user', env.smtpUser);
    const pass = await getOrEnvFallback('email.smtp.pass', env.smtpPass);
    // Half-configured auth (user without pass or vice-versa) is almost
    // always a config typo — silently falling back to an unauthenticated
    // session lets the send "succeed" against a relay that will then drop
    // or spam-tag the message. Refuse loudly so the admin sees the gap.
    if (Boolean(user) !== Boolean(pass)) {
      throw new Error(
        'smtp_partial_auth_configured: both email.smtp.user and email.smtp.pass must be set together',
      );
    }
    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
    });
  }

  async send(msg: EmailMessage) {
    const from = await resolveEmailFrom('postfix');
    const to = normalizeRecipient(msg.to);
    const transport = await this.buildTransport();
    const info = await transport.sendMail({
      from,
      to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: msg.headers,
      replyTo: msg.replyTo,
    });
    logger.info('email.postfix_sent', { to, id: info.messageId });
    return {
      id: info.messageId,
      status: (info.accepted?.length ? 'sent' : 'queued') as 'sent' | 'queued',
    };
  }
}

/** Admin-selected email provider from firm_settings.email_provider, with a
 *  cleartext env-var fallback (EMAIL_PROVIDER) so installs that predate the
 *  UI-selectable setting keep working until an admin picks one in the UI.
 *
 *  EMAIL_PROVIDER=none short-circuits the DB lookup: "no mail" is an
 *  appliance-bootstrap concern, not a per-firm runtime toggle. The
 *  firm_settings.email_provider enum doesn't include 'none' precisely
 *  because we don't want an admin clicking it off — the appliance
 *  operator does. */
async function resolveEmailProviderKind(): Promise<
  'mock' | 'postmark' | 'postfix' | 'emailit' | 'none'
> {
  if (env.emailProvider === 'none') return 'none';
  try {
    const { db } = await import('../../db/knex.js');
    const row = await db('firm_settings').where({ id: 1 }).first('email_provider');
    const picked = row?.email_provider as string | undefined;
    if (picked === 'postmark' || picked === 'postfix' || picked === 'emailit' || picked === 'mock')
      return picked;
  } catch (err) {
    // DB unreachable (boot race, maintenance window). Fall through to env so
    // we fail safer — a misconfigured DB shouldn't break outbound mail.
    logger.warn('email_provider_db_lookup_failed', {
      msg: err instanceof Error ? err.message : String(err),
    });
  }
  return env.emailProvider;
}

export type EmailProviderKind = 'mock' | 'postmark' | 'postfix' | 'emailit' | 'none';

/**
 * Factory for a SPECIFIC provider, bypassing the resolver. Used by the
 * Admin → Providers "Test" button so an admin can verify a provider's
 * credentials are working before flipping `firm_settings.email_provider`
 * to it (otherwise testing a new provider would require flipping the
 * setting first, taking outbound mail with it on failure).
 */
export function buildEmailProvider(kind: EmailProviderKind): EmailProvider {
  switch (kind) {
    case 'postmark':
      return new PostmarkProvider();
    case 'postfix':
      return new PostfixProvider();
    case 'emailit':
      return new EmailitProvider();
    case 'none':
      return new NoneProvider();
    case 'mock':
    default:
      return new MockProvider();
  }
}

/** What the resolver currently picks. Exposed so Admin → Providers can
 *  surface "Emailit (active)" vs "Postmark (configured but not active)". */
export async function currentEmailProviderKind(): Promise<EmailProviderKind> {
  return resolveEmailProviderKind();
}

export async function getEmailProvider(): Promise<EmailProvider> {
  switch (await resolveEmailProviderKind()) {
    case 'postmark':
      return new PostmarkProvider();
    case 'postfix':
      return new PostfixProvider();
    case 'emailit':
      return new EmailitProvider();
    case 'none':
      return new NoneProvider();
    case 'mock':
    default:
      return new MockProvider();
  }
}
