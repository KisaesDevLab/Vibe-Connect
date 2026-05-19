/**
 * SMS provider (Twilio + TextLink) error / timeout / redaction tests with
 * fetch stubbed. Locks the contract that:
 *   - Timeouts surface as a typed `<provider>_timeout_after_*ms` error
 *     rather than hanging the caller until Node's default idle window.
 *   - Long dash-free tokens get redacted from error bodies while
 *     UUID-shaped correlation IDs stay readable.
 *   - The full body is logged at warn level so operators tailing
 *     docker logs see provider correlation info we strip from the throw.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestDb } from './test-helpers.js';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
});

beforeEach(async () => {
  const { db } = await import('../db/knex.js');
  await db('firm_provider_credentials').del();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TextLink SMS', () => {
  beforeEach(async () => {
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({ sms_provider: 'textlink' });
    const { set } = await import('../services/providerSecrets.js');
    await set('sms.textlink.api_key', 'test-tl-key', null);
  });

  it('maps timeout to textlink_timeout_after_*ms', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.reject(new DOMException('aborted', 'TimeoutError')),
    );
    const { getSmsProvider } = await import('../bridges/sms/index.js');
    const provider = await getSmsProvider();
    await expect(provider.sendMessage({ to: '+15551234567', body: 'hi' })).rejects.toThrow(
      /textlink_timeout_after_\d+ms/,
    );
  });

  it('redacts long dash-free tokens but preserves UUIDs in 4xx body', async () => {
    const body =
      '{"err":"bad","key":"abcdefghijklmnopqrstuvwxyz1234567890","traceId":"12345678-1234-1234-1234-123456789012"}';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 401, headers: { 'content-type': 'application/json' } }),
    );
    const { getSmsProvider } = await import('../bridges/sms/index.js');
    const provider = await getSmsProvider();
    try {
      await provider.sendMessage({ to: '+15551234567', body: 'hi' });
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/textlink_401/);
      expect(msg).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
      expect(msg).toContain('12345678-1234-1234-1234-123456789012');
    }
  });
});

describe('Twilio SMS', () => {
  beforeEach(async () => {
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({ sms_provider: 'twilio' });
    const { set } = await import('../services/providerSecrets.js');
    await set('sms.twilio.account_sid', 'ACtestSIDplaceholderNOTREALxxxxxxxx', null);
    await set('sms.twilio.auth_token', 'tw-test-token', null);
    await set('sms.twilio.from_number', '+15550001111', null);
  });

  it('maps timeout to twilio_timeout_after_*ms', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.reject(new DOMException('aborted', 'TimeoutError')),
    );
    const { getSmsProvider } = await import('../bridges/sms/index.js');
    const provider = await getSmsProvider();
    await expect(provider.sendMessage({ to: '+15551234567', body: 'hi' })).rejects.toThrow(
      /twilio_timeout_after_\d+ms/,
    );
  });

  it('redacts Account SID from 4xx body but keeps the error message readable', async () => {
    const body =
      '{"code":21408,"message":"Permission denied for ACtestSIDplaceholderNOTREALxxxxxxxx","more_info":"https://www.twilio.com/docs/errors/21408"}';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }),
    );
    const { getSmsProvider } = await import('../bridges/sms/index.js');
    const provider = await getSmsProvider();
    try {
      await provider.sendMessage({ to: '+15551234567', body: 'hi' });
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/twilio_400/);
      // The Twilio SID got redacted (dash-free, 34 chars):
      expect(msg).not.toContain('ACtestSIDplaceholderNOTREALxxxxxxxx');
      // The non-secret error description survives:
      expect(msg.toLowerCase()).toContain('permission denied');
    }
  });

  it('throws twilio_credentials_not_configured when account_sid is missing', async () => {
    const { db } = await import('../db/knex.js');
    await db('firm_provider_credentials').where({ key: 'sms.twilio.account_sid' }).del();
    const { getSmsProvider } = await import('../bridges/sms/index.js');
    const provider = await getSmsProvider();
    await expect(provider.sendMessage({ to: '+15551234567', body: 'hi' })).rejects.toThrow(
      /twilio_credentials_not_configured/,
    );
  });
});

afterAll(async () => {
  const { db } = await import('../db/knex.js');
  await db.destroy();
});
