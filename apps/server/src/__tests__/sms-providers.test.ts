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

  it('posts to /api/send-sms with Bearer auth + spec-shaped body (phone_number + text)', async () => {
    // Regression for the silent-failure bug in v0.4.21 and earlier: api
    // key was in the JSON body instead of the Authorization header, and
    // the body used `to`/`message` instead of `phone_number`/`text` as
    // the spec requires. https://docs.textlinksms.com/api#sending-an-sms
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { getSmsProvider } = await import('../bridges/sms/index.js');
    const provider = await getSmsProvider();
    const result = await provider.sendMessage({ to: '+15551234567', body: 'hi there' });
    expect(result.status).toBe('sent');

    const [urlArg, initArg] = fetchSpy.mock.calls[0]!;
    expect(String(urlArg)).toBe('https://textlinksms.com/api/send-sms');
    const init = initArg as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-tl-key');
    expect(headers['content-type']).toBe('application/json');
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent.phone_number).toBe('+15551234567');
    expect(sent.text).toBe('hi there');
    // api_key MUST NOT appear in the body (it goes in the header).
    expect('apiKey' in sent).toBe(false);
    expect('api_key' in sent).toBe(false);
  });

  it('treats `queued: true` as success but reports status="queued"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, queued: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { getSmsProvider } = await import('../bridges/sms/index.js');
    const provider = await getSmsProvider();
    const result = await provider.sendMessage({ to: '+15551234567', body: 'hi' });
    expect(result.status).toBe('queued');
  });

  it('THROWS when response is HTTP 200 with `ok: false` (silent-failure regression)', async () => {
    // The user-reported bug: TextLink returns 200 OK with { ok: false,
    // message: "..." } on a failed send (no SIM available, phone offline,
    // etc.). Pre-v0.4.22 we checked HTTP status only, so every failure
    // was reported as "sent" to the staff invite toast — no SMS went out
    // but the UI claimed it had. The fix must parse `ok` and throw with
    // the `message` text.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, message: 'No SIM cards available' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { getSmsProvider } = await import('../bridges/sms/index.js');
    const provider = await getSmsProvider();
    await expect(provider.sendMessage({ to: '+15551234567', body: 'hi' })).rejects.toThrow(
      /textlink_send_failed: No SIM cards available/,
    );
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

  it('surfaces a real HTTP error (non-200) with redacted body', async () => {
    // Non-200 from TextLink means the API itself is broken (deploy /
    // outage / rate limit), not a "send failed". Distinct error string
    // so an operator can tell them apart.
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

describe('Phone normalisation at the provider boundary', () => {
  // Pre-fix, only the Admin → Providers Test endpoint normalised E.164.
  // Every other caller (offline-notify, intake notify, smsBridge
  // outbound, portal access code, invite, intakeAdmin send-link) passed
  // the phone raw, so a value stored without the `+` was silently
  // rejected by Twilio/TextLink. Pushing normalisation into the
  // provider boundary means every caller benefits automatically.
  beforeEach(async () => {
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({ sms_provider: 'textlink' });
    const { set } = await import('../services/providerSecrets.js');
    await set('sms.textlink.api_key', 'test-tl-key', null);
  });

  it('US 10-digit gets prefixed with +1 on the wire', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { getSmsProvider } = await import('../bridges/sms/index.js');
    const provider = await getSmsProvider();
    await provider.sendMessage({ to: '5551234567', body: 'hi' });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent.phone_number).toBe('+15551234567');
  });

  it('US-formatted "(555) 123-4567" gets normalised to E.164', async () => {
    // The shape a CPA-firm admin actually types into the intake send-
    // link form. intakeAdmin's zod schema lets it through because the
    // regex permits parens / dashes; the provider boundary canonicalises.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { getSmsProvider } = await import('../bridges/sms/index.js');
    const provider = await getSmsProvider();
    await provider.sendMessage({ to: '(555) 123-4567', body: 'hi' });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent.phone_number).toBe('+15551234567');
  });

  it('rejects garbage input with sms_phone_invalid before hitting the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { getSmsProvider } = await import('../bridges/sms/index.js');
    const provider = await getSmsProvider();
    await expect(provider.sendMessage({ to: 'not-a-phone', body: 'hi' })).rejects.toThrow(
      /sms_phone_invalid/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects empty `to` with sms_phone_invalid', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { getSmsProvider } = await import('../bridges/sms/index.js');
    const provider = await getSmsProvider();
    await expect(provider.sendMessage({ to: '   ', body: 'hi' })).rejects.toThrow(
      /sms_phone_invalid/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  const { db } = await import('../db/knex.js');
  await db.destroy();
});
