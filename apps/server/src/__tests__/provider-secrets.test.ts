/**
 * Admin-writable provider credentials. Covers:
 *   - Roundtrip encrypt/decrypt via the service (sealed_value is ciphertext)
 *   - GET /admin/providers returns metadata, never plaintext
 *   - PUT writes, audits, updates last4
 *   - DELETE clears, audits
 *   - Unknown keys rejected
 *   - Non-admin staff forbidden
 *   - env fallback when DB empty
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { resetTestDb } from './test-helpers.js';

let app: Express;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
  const mod = await import('../app.js');
  app = mod.createApp();
});

type TestAgent = ReturnType<typeof request.agent>;
async function loginAs(username: string, password: string): Promise<TestAgent> {
  const agent = request.agent(app);
  const login = await agent.post('/auth/login').send({ username, password });
  if (login.status !== 200) {
    throw new Error(`loginAs(${username}) failed: ${login.status}`);
  }
  return agent;
}

beforeEach(async () => {
  const { db } = await import('../db/knex.js');
  await db('firm_provider_credentials').del();
});

describe('providerSecrets service', () => {
  it('encrypts at rest — sealed_value never contains the plaintext', async () => {
    const svc = await import('../services/providerSecrets.js');
    const { db } = await import('../db/knex.js');
    const distinctive = 'twilio-auth-SECRETVALUE-abc123-should-not-appear-in-db';
    await svc.set('sms.twilio.auth_token', distinctive, null);
    const row = await db('firm_provider_credentials')
      .where({ key: 'sms.twilio.auth_token' })
      .first();
    expect(row).toBeTruthy();
    expect(row.sealed_value).toEqual(expect.any(String));
    // sealed_value is base64(nonce || ciphertext); plaintext must not appear.
    expect(row.sealed_value).not.toContain(distinctive);
    // last4 is exposed for UI display — the final 4 chars of the trimmed value.
    expect(row.last4).toBe('n-db');

    const readBack = await svc.get('sms.twilio.auth_token');
    expect(readBack).toBe(distinctive);
  });

  it('returns null for unknown keys and after clear()', async () => {
    const svc = await import('../services/providerSecrets.js');
    expect(await svc.get('sms.twilio.auth_token')).toBeNull();

    await svc.set('sms.twilio.auth_token', 'AC_live_abcdef1234', null);
    expect(await svc.get('sms.twilio.auth_token')).toBe('AC_live_abcdef1234');

    await svc.clear('sms.twilio.auth_token', null);
    expect(await svc.get('sms.twilio.auth_token')).toBeNull();
  });

  it('falls back to env when DB row is absent, prefers DB when both exist', async () => {
    const svc = await import('../services/providerSecrets.js');
    expect(await svc.getOrEnvFallback('sms.textlink.api_key', 'ENV-ONLY')).toBe('ENV-ONLY');
    expect(await svc.getOrEnvFallback('sms.textlink.api_key', null)).toBeNull();
    await svc.set('sms.textlink.api_key', 'DB-WINS', null);
    expect(await svc.getOrEnvFallback('sms.textlink.api_key', 'ENV-ONLY')).toBe('DB-WINS');
  });
});

describe('admin providers API', () => {
  it('GET returns one row per registry key, never the plaintext', async () => {
    const svc = await import('../services/providerSecrets.js');
    await svc.set('sms.twilio.auth_token', 'plaintext-value-SECRET', null);

    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const res = await admin.get('/admin/providers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    // Every known key is present in the response (even unset ones).
    expect(res.body.items.map((x: { key: string }) => x.key)).toEqual(
      expect.arrayContaining([
        'sms.twilio.auth_token',
        'sms.textlink.api_key',
        'email.postmark.server_token',
        'email.smtp.host',
      ]),
    );
    const twilio = res.body.items.find((x: { key: string }) => x.key === 'sms.twilio.auth_token');
    expect(twilio).toEqual(
      expect.objectContaining({
        configured: true,
        last4: 'CRET',
        masked: true,
      }),
    );
    // CRITICAL: plaintext must never appear anywhere in the JSON response.
    expect(JSON.stringify(res.body)).not.toContain('plaintext-value-SECRET');
  });

  it('PUT writes + audits; last4 reflects the value; the plaintext is not echoed', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const res = await admin
      .put('/admin/providers/sms.twilio.auth_token')
      .send({ value: 'AC_test_abcdefghijklmnop_1234' });
    expect(res.status).toBe(200);
    expect(res.body.meta.configured).toBe(true);
    expect(res.body.meta.last4).toBe('1234');
    expect(JSON.stringify(res.body)).not.toContain('abcdefghijklmnop');

    const { db } = await import('../db/knex.js');
    const audit = await db('audit_log')
      .where({ action: 'admin.provider_secret_updated', target_id: 'sms.twilio.auth_token' })
      .orderBy('created_at', 'desc')
      .first();
    expect(audit).toBeTruthy();
    // Audit detail carries last4 + SHA-256 fingerprint, NOT the value itself.
    expect(audit.details.last4).toBe('1234');
    expect(audit.details.fingerprint).toEqual(expect.any(String));
    expect(JSON.stringify(audit.details)).not.toContain('abcdefghijklmnop');
  });

  it('PUT rejects unknown keys with 400', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const res = await admin.put('/admin/providers/not.a.real.key').send({ value: 'whatever' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_key');
  });

  it('PUT rejects empty value with 400', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const res = await admin.put('/admin/providers/sms.twilio.auth_token').send({ value: '   ' });
    expect([400]).toContain(res.status);
  });

  it('DELETE clears + audits; metaList marks configured=false', async () => {
    const svc = await import('../services/providerSecrets.js');
    await svc.set('sms.textlink.api_key', 'tl_api_ZZZZZZZZ_9999', null);

    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const res = await admin.delete('/admin/providers/sms.textlink.api_key');
    expect(res.status).toBe(200);
    expect(res.body.meta.configured).toBe(false);
    expect(res.body.meta.last4).toBeNull();

    const { db } = await import('../db/knex.js');
    const audit = await db('audit_log')
      .where({ action: 'admin.provider_secret_cleared', target_id: 'sms.textlink.api_key' })
      .first();
    expect(audit).toBeTruthy();
  });

  it('requires admin — non-admin staff cannot read or write', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r1 = await alice.get('/admin/providers');
    const r2 = await alice.put('/admin/providers/sms.twilio.auth_token').send({ value: 'x' });
    const r3 = await alice.delete('/admin/providers/sms.twilio.auth_token');
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
    expect(r3.status).toBe(403);
  });
});

afterAll(async () => {
  const { db } = await import('../db/knex.js');
  await db.destroy();
});
