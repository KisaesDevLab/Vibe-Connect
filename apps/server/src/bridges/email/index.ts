// Email provider interface + mock + Postmark + Postfix stubs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

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

class PostmarkProvider implements EmailProvider {
  name = 'postmark';
  async send(msg: EmailMessage) {
    if (!env.postmarkServerToken) throw new Error('POSTMARK_SERVER_TOKEN not configured');
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
        'X-Postmark-Server-Token': env.postmarkServerToken,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`postmark_${res.status}: ${txt}`);
    }
    const data = (await res.json()) as { MessageID: string };
    return { id: data.MessageID, status: 'sent' as const };
  }
}

class PostfixProvider implements EmailProvider {
  name = 'postfix';
  async send(msg: EmailMessage) {
    // Placeholder: integrate with a self-hosted Postfix via SMTP in ops. Dev default is mock.
    logger.warn('email.postfix_not_implemented', { to: msg.to });
    return { id: `postfix-stub-${Date.now()}`, status: 'queued' as const };
  }
}

export function getEmailProvider(): EmailProvider {
  switch (env.emailProvider) {
    case 'postmark':
      return new PostmarkProvider();
    case 'postfix':
      return new PostfixProvider();
    case 'mock':
    default:
      return new MockProvider();
  }
}
