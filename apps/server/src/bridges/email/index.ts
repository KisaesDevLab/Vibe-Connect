// Email provider interface + mock + Postmark + Postfix-SMTP implementations.
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

export interface EmailProvider {
  send(msg: EmailMessage): Promise<{ id: string; status: 'sent' | 'queued' | 'bounced' }>;
  name: string;
}

class MockProvider implements EmailProvider {
  name = 'mock';
  async send(msg: EmailMessage) {
    const outbox = path.resolve(env.outboxDir, 'email');
    await fs.mkdir(outbox, { recursive: true });
    const id = `mock-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const file = path.join(outbox, `${id}.json`);
    await fs.writeFile(file, JSON.stringify({ ...msg, id, at: new Date().toISOString() }, null, 2));
    logger.info('email.mock_sent', { file, to: msg.to, subject: msg.subject });
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
    logger.warn('email.disabled_send_skipped', {
      to: msg.to,
      subject: msg.subject,
      hint: 'EMAIL_PROVIDER=none — set EMAIL_PROVIDER and provider credentials to enable outbound mail.',
    });
    return { id: `none-${Date.now()}`, status: 'sent' as const };
  }
}

class PostmarkProvider implements EmailProvider {
  name = 'postmark';
  async send(msg: EmailMessage) {
    const token = await getOrEnvFallback('email.postmark.server_token', env.postmarkServerToken);
    if (!token) throw new Error('postmark_token_not_configured');
    const body = {
      From: env.emailFrom,
      To: msg.to,
      Subject: msg.subject,
      TextBody: msg.text,
      HtmlBody: msg.html,
      Headers: Object.entries(msg.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
      ReplyTo: msg.replyTo,
      MessageStream: 'outbound',
    };
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Postmark-Server-Token': token,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Postmark returns the token in error replies for some 4xx cases. Strip
      // any bearer-like substrings from the body before surfacing — we don't
      // want credentials to land in audit details via the bridge's error path.
      const txt = (await res.text()).replace(/[A-Za-z0-9-]{20,}/g, '[redacted]');
      throw new Error(`postmark_${res.status}: ${txt}`);
    }
    const data = (await res.json()) as { MessageID: string };
    return { id: data.MessageID, status: 'sent' as const };
  }
}

// Emailit v2 transactional API (https://emailit.com/docs/api-reference/emails/send/).
// Ported from the production client in Vibe-Payroll-Time —
// notable details an earlier integration in another product got wrong:
//   * URL is /v2/ (not /v1/).
//   * `from` is an RFC 5322 string ("Name <email>" or bare email), not a
//     {email, name} object.
//   * `to` is a string or string[], not an [{email}] array.
//   * Auth is Bearer <api_key>.
const DEFAULT_EMAILIT_BASE_URL = 'https://api.emailit.com/v2';
const EMAILIT_TIMEOUT_MS = 15_000;
class EmailitProvider implements EmailProvider {
  name = 'emailit';
  async send(msg: EmailMessage) {
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
      from: env.emailFrom,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(msg.headers && Object.keys(msg.headers).length > 0 ? { headers: msg.headers } : {}),
    };
    let res: Response;
    try {
      res = await fetch(`${base}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(EMAILIT_TIMEOUT_MS),
      });
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
      throw new Error(
        isTimeout
          ? `emailit_timeout_after_${EMAILIT_TIMEOUT_MS}ms`
          : `emailit_network_error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      // Strip anything that looks like a bearer token from the body before
      // surfacing it — matches the redaction posture of PostmarkProvider.
      const txt = (await res.text()).replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]');
      throw new Error(`emailit_${res.status}: ${txt.slice(0, 200)}`);
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
    logger.info('email.emailit_sent', { to: msg.to, id });
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
    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
    });
  }

  async send(msg: EmailMessage) {
    const transport = await this.buildTransport();
    const info = await transport.sendMail({
      from: env.emailFrom,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: msg.headers,
      replyTo: msg.replyTo,
    });
    logger.info('email.postfix_sent', { to: msg.to, id: info.messageId });
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
    if (
      picked === 'postmark' ||
      picked === 'postfix' ||
      picked === 'emailit' ||
      picked === 'mock'
    )
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
