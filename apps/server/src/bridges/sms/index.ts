// SMS provider interface + mock + TextLink + Twilio adapters.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { getOrEnvFallback } from '../../services/providerSecrets.js';

export interface SmsSendRequest {
  to: string;
  body: string;
}

export interface SmsInbound {
  from: string;
  to: string;
  body: string;
  providerMessageId: string;
  receivedAt: string;
}

export interface WebhookVerifyContext {
  headers: Record<string, string>;
  rawBody: string;
  /** Fully-qualified URL the provider POSTed to — required for Twilio signature check. */
  url: string;
  /** Parsed body params (for x-www-form-urlencoded Twilio payloads). */
  params?: Record<string, string>;
}

export interface SmsProvider {
  name: 'mock' | 'textlink' | 'twilio';
  sendMessage(req: SmsSendRequest): Promise<{ id: string; status: 'sent' | 'queued' }>;
  parseInbound(req: { body: unknown; headers: Record<string, string> }): SmsInbound | null;
  /**
   * Verify an inbound webhook signature. Async so the implementation can fetch
   * the current webhook secret from firm_provider_credentials — rotating the
   * secret in the Admin UI takes effect on the next inbound without a restart.
   * A sync impl would be forced to read a stale env-only value.
   */
  verifyWebhookSignature(ctx: WebhookVerifyContext): Promise<boolean> | boolean;
}

class MockSms implements SmsProvider {
  name = 'mock' as const;
  async sendMessage(req: SmsSendRequest) {
    const outbox = path.resolve(env.outboxDir, 'sms');
    await fs.mkdir(outbox, { recursive: true });
    const id = `mock-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    await fs.writeFile(
      path.join(outbox, `${id}.json`),
      JSON.stringify({ ...req, id, at: new Date().toISOString() }, null, 2),
    );
    logger.info('sms.mock_sent', { to: req.to });
    return { id, status: 'sent' as const };
  }
  parseInbound(req: { body: unknown }): SmsInbound | null {
    const b = req.body as { from?: string; to?: string; body?: string; id?: string };
    if (!b?.from || !b?.to || !b?.body) return null;
    return {
      from: b.from,
      to: b.to,
      body: b.body,
      providerMessageId: b.id ?? crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
    };
  }
  verifyWebhookSignature(): boolean {
    // Mock provider must only be used when SMS_PROVIDER=mock (dev/test).
    return env.smsProvider === 'mock';
  }
}

class TextLinkSms implements SmsProvider {
  name = 'textlink' as const;
  async sendMessage(req: SmsSendRequest) {
    const apiKey = await getOrEnvFallback('sms.textlink.api_key', env.textlinkApiKey);
    if (!apiKey) throw new Error('textlink_api_key_not_configured');
    const res = await fetch('https://textlinksms.com/api/send-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, to: req.to, message: req.body }),
    });
    if (!res.ok) throw new Error(`textlink_${res.status}`);
    const data = (await res.json()) as { messageId?: string };
    return { id: data.messageId ?? crypto.randomUUID(), status: 'sent' as const };
  }
  parseInbound(req: { body: unknown }): SmsInbound | null {
    const b = req.body as {
      from?: string;
      to?: string;
      message?: string;
      messageId?: string;
    };
    if (!b?.from || !b?.to || !b?.message) return null;
    return {
      from: b.from,
      to: b.to,
      body: b.message,
      providerMessageId: b.messageId ?? crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
    };
  }
  async verifyWebhookSignature(ctx: WebhookVerifyContext): Promise<boolean> {
    // Pull the currently-configured webhook secret from the DB-backed
    // registry, falling back to the env var for pre-migration installs.
    // Rotating the secret via Admin → Providers now takes effect on the
    // next inbound — previously it was env-only and needed a restart.
    const secret = await getOrEnvFallback('sms.textlink.webhook_secret', env.textlinkWebhookSecret);
    if (!secret) {
      logger.error('sms.textlink.webhook_secret_missing');
      return false;
    }
    const expected = crypto.createHmac('sha256', secret).update(ctx.rawBody).digest('hex');
    const got = ctx.headers['x-textlink-signature'] ?? ctx.headers['X-TextLink-Signature'] ?? '';
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(got, 'hex'));
    } catch {
      return false;
    }
  }
}

class TwilioSms implements SmsProvider {
  name = 'twilio' as const;
  async sendMessage(req: SmsSendRequest) {
    const [accountSid, authToken, fromNumber, messagingServiceSid] = await Promise.all([
      getOrEnvFallback('sms.twilio.account_sid', env.twilioAccountSid),
      getOrEnvFallback('sms.twilio.auth_token', env.twilioAuthToken),
      getOrEnvFallback('sms.twilio.from_number', env.twilioFromNumber),
      getOrEnvFallback('sms.twilio.messaging_service_sid', env.twilioMessagingServiceSid),
    ]);
    if (!accountSid || !authToken) {
      throw new Error('twilio_credentials_not_configured');
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const form = new URLSearchParams();
    form.set('To', req.to);
    form.set('Body', req.body);
    if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
    else if (fromNumber) form.set('From', fromNumber);
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    if (!res.ok) {
      // Twilio surfaces the account SID in error payloads. Strip any 20+ char
      // alnum runs before bubbling so we never leak token-shaped material
      // into upstream error logs / audit details.
      const txt = (await res.text()).replace(/[A-Za-z0-9]{20,}/g, '[redacted]');
      throw new Error(`twilio_${res.status}: ${txt}`);
    }
    const data = (await res.json()) as { sid: string };
    return { id: data.sid, status: 'sent' as const };
  }
  parseInbound(req: { body: unknown }): SmsInbound | null {
    const b = req.body as {
      From?: string;
      To?: string;
      Body?: string;
      MessageSid?: string;
    };
    if (!b?.From || !b?.To || !b?.Body) return null;
    return {
      from: b.From,
      to: b.To,
      body: b.Body,
      providerMessageId: b.MessageSid ?? crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
    };
  }
  async verifyWebhookSignature(ctx: WebhookVerifyContext): Promise<boolean> {
    // Twilio signature: base64(HMAC-SHA1(authToken, url + sorted(k+v).join('')))
    // See: https://www.twilio.com/docs/usage/webhooks/webhooks-security
    const authToken = await getOrEnvFallback('sms.twilio.auth_token', env.twilioAuthToken);
    if (!authToken) {
      logger.error('sms.twilio.auth_token_missing');
      return false;
    }
    const sig = ctx.headers['x-twilio-signature'] ?? ctx.headers['X-Twilio-Signature'];
    if (!sig || !ctx.params) return false;
    const sortedKeys = Object.keys(ctx.params).sort();
    let data = ctx.url;
    for (const k of sortedKeys) data += k + ctx.params[k];
    const expected = crypto
      .createHmac('sha1', authToken)
      .update(Buffer.from(data, 'utf8'))
      .digest('base64');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8'));
    } catch {
      return false;
    }
  }
}

/** Admin-selected SMS provider from firm_settings.sms_provider, env fallback.
 *  See bridges/email for the matching pattern + rationale. */
async function resolveSmsProviderKind(): Promise<'mock' | 'textlink' | 'twilio'> {
  try {
    const { db } = await import('../../db/knex.js');
    const row = await db('firm_settings').where({ id: 1 }).first('sms_provider');
    const picked = row?.sms_provider as string | undefined;
    if (picked === 'textlink' || picked === 'twilio' || picked === 'mock') return picked;
  } catch (err) {
    logger.warn('sms_provider_db_lookup_failed', {
      msg: err instanceof Error ? err.message : String(err),
    });
  }
  return env.smsProvider;
}

export async function getSmsProvider(): Promise<SmsProvider> {
  switch (await resolveSmsProviderKind()) {
    case 'textlink':
      return new TextLinkSms();
    case 'twilio':
      return new TwilioSms();
    case 'mock':
    default:
      return new MockSms();
  }
}
