/**
 * EmailitProvider unit test. Stubs global fetch so we can assert the wire
 * shape we send to api.emailit.com — this is the layer the production
 * implementation in another Vibe product got wrong on its first cut
 * (v1 URL, object-shaped `from`, array-of-object `to`). Locking the
 * contract here is cheap insurance against the same regression here.
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
  await db('firm_settings').where({ id: 1 }).update({ email_provider: 'emailit' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EmailitProvider', () => {
  it('posts to /v2/emails with bearer auth and RFC 5322 fields', async () => {
    const { set } = await import('../services/providerSecrets.js');
    await set('email.emailit.api_key', 'test-key-abc', null);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'em_123', status: 'queued' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { getEmailProvider } = await import('../bridges/email/index.js');
    const provider = await getEmailProvider();
    expect(provider.name).toBe('emailit');

    const result = await provider.send({
      to: 'client@example.com',
      subject: 'hello',
      text: 'plain body',
      html: '<p>html body</p>',
    });

    expect(result.id).toBe('em_123');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [urlArg, initArg] = fetchSpy.mock.calls[0]!;
    expect(String(urlArg)).toBe('https://api.emailit.com/v2/emails');
    const init = initArg as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key-abc');
    expect(headers['content-type']).toBe('application/json');
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    // `from` must be a string (RFC 5322), not {email, name}.
    expect(typeof sent.from).toBe('string');
    // `to` must be a string (or string[]), never [{email}].
    expect(typeof sent.to === 'string' || Array.isArray(sent.to)).toBe(true);
    expect(sent.subject).toBe('hello');
    expect(sent.text).toBe('plain body');
    expect(sent.html).toBe('<p>html body</p>');
  });

  it('honors the firm-overridden base URL', async () => {
    const { set } = await import('../services/providerSecrets.js');
    await set('email.emailit.api_key', 'test-key', null);
    await set('email.emailit.base_url', 'https://eu.api.emailit.com/v2/', null);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'em_eu' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { getEmailProvider } = await import('../bridges/email/index.js');
    const provider = await getEmailProvider();
    await provider.send({ to: 'a@b.com', subject: 's', text: 't' });

    const [urlArg] = fetchSpy.mock.calls[0]!;
    // Trailing slash stripped, /emails appended.
    expect(String(urlArg)).toBe('https://eu.api.emailit.com/v2/emails');
  });

  it('throws a redacted error on non-2xx', async () => {
    const { set } = await import('../services/providerSecrets.js');
    await set('email.emailit.api_key', 'test-key', null);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"bad_auth","trace":"abcdefghijklmnopqrstuvwxyz0123456789"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { getEmailProvider } = await import('../bridges/email/index.js');
    const provider = await getEmailProvider();
    await expect(provider.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow(
      /emailit_401/,
    );
  });

  it('throws when api_key is missing', async () => {
    // No secret stored, env fallback also empty (tests start with EMAILIT_API_KEY unset).
    const { getEmailProvider } = await import('../bridges/email/index.js');
    const provider = await getEmailProvider();
    await expect(provider.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow(
      /emailit_api_key_not_configured/,
    );
  });
});

afterAll(async () => {
  const { db } = await import('../db/knex.js');
  await db.destroy();
});
