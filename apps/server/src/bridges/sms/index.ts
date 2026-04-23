// SMS provider interface + mock + TextLink + Twilio adapters.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

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
  verifyWebhookSignature(ctx: WebhookVerifyContext): boolean;
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
    if (!env.textlinkApiKey) throw new Error('TEXTLINK_API_KEY not configured');
    const res = await fetch('https://textlinksms.com/api/send-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: env.textlinkApiKey, to: req.to, message: req.body }),
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
  verifyWebhookSignature(ctx: WebhookVerifyContext): boolean {
    if (!env.textlinkWebhookSecret) {
      // Fail closed when a non-mock provider is active with no secret configured.
      logger.error('sms.textlink.webhook_secret_missing');
      return false;
    }
    const expected = crypto
      .createHmac('sha256', env.textlinkWebhookSecret)
      .update(ctx.rawBody)
      .digest('hex');
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
    if (!env.twilioAccountSid || !env.twilioAuthToken) {
      throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured');
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Messages.json`;
    const form = new URLSearchParams();
    form.set('To', req.to);
    form.set('Body', req.body);
    if (env.twilioMessagingServiceSid)
      form.set('MessagingServiceSid', env.twilioMessagingServiceSid);
    else if (env.twilioFromNumber) form.set('From', env.twilioFromNumber);
    const auth = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString('base64');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    if (!res.ok) {
      const txt = await res.text();
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
  verifyWebhookSignature(ctx: WebhookVerifyContext): boolean {
    // Twilio signature: base64(HMAC-SHA1(authToken, url + sorted(k+v).join('')))
    // See: https://www.twilio.com/docs/usage/webhooks/webhooks-security
    if (!env.twilioAuthToken) {
      logger.error('sms.twilio.auth_token_missing');
      return false;
    }
    const sig = ctx.headers['x-twilio-signature'] ?? ctx.headers['X-Twilio-Signature'];
    if (!sig || !ctx.params) return false;
    const sortedKeys = Object.keys(ctx.params).sort();
    let data = ctx.url;
    for (const k of sortedKeys) data += k + ctx.params[k];
    const expected = crypto
      .createHmac('sha1', env.twilioAuthToken)
      .update(Buffer.from(data, 'utf8'))
      .digest('base64');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8'));
    } catch {
      return false;
    }
  }
}

export function getSmsProvider(): SmsProvider {
  switch (env.smsProvider) {
    case 'textlink':
      return new TextLinkSms();
    case 'twilio':
      return new TwilioSms();
    case 'mock':
    default:
      return new MockSms();
  }
}
