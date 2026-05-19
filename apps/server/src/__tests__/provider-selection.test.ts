/**
 * DB-backed provider selection: getSmsProvider() / getEmailProvider() must
 * prefer firm_settings.{sms,email}_provider over the env var fallback. This
 * test reinstates trust in the Admin → Settings dropdowns — before this
 * change, the SMS picker wrote to the DB but the bridge ignored it.
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

async function loginAs(username: string, password: string) {
  const agent = request.agent(app);
  const r = await agent.post('/auth/login').send({ username, password });
  if (r.status !== 200) throw new Error(`login_${r.status}`);
  return agent;
}

beforeEach(async () => {
  const { db } = await import('../db/knex.js');
  // Reset providers to mock so tests start from a clean baseline.
  await db('firm_settings')
    .where({ id: 1 })
    .update({ sms_provider: 'mock', email_provider: 'mock' });
});

describe('DB-backed provider selection', () => {
  it('getEmailProvider honors firm_settings.email_provider', async () => {
    const { db } = await import('../db/knex.js');
    const { getEmailProvider } = await import('../bridges/email/index.js');

    // Default (mock) baseline.
    expect((await getEmailProvider()).name).toBe('mock');

    // Flip to postmark at the DB and the bridge picks it up on next resolve.
    await db('firm_settings').where({ id: 1 }).update({ email_provider: 'postmark' });
    expect((await getEmailProvider()).name).toBe('postmark');

    await db('firm_settings').where({ id: 1 }).update({ email_provider: 'postfix' });
    expect((await getEmailProvider()).name).toBe('postfix');

    await db('firm_settings').where({ id: 1 }).update({ email_provider: 'emailit' });
    expect((await getEmailProvider()).name).toBe('emailit');
  });

  it('getSmsProvider honors firm_settings.sms_provider', async () => {
    const { db } = await import('../db/knex.js');
    const { getSmsProvider } = await import('../bridges/sms/index.js');

    expect((await getSmsProvider()).name).toBe('mock');

    await db('firm_settings').where({ id: 1 }).update({ sms_provider: 'twilio' });
    expect((await getSmsProvider()).name).toBe('twilio');

    await db('firm_settings').where({ id: 1 }).update({ sms_provider: 'textlink' });
    expect((await getSmsProvider()).name).toBe('textlink');
  });

  it('PATCH /admin/settings persists emailProvider and GET returns it', async () => {
    // The pre-flight guard blocks flipping emailProvider to a provider whose
    // secrets are not yet stored. Seed Postmark's server_token first so the
    // happy path proceeds.
    const { set: setProviderSecret } = await import('../services/providerSecrets.js');
    await setProviderSecret('email.postmark.server_token', 'test-token-12345', null);
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const patched = await admin.patch('/admin/settings').send({ emailProvider: 'postmark' });
    expect(patched.status).toBe(200);

    const read = await admin.get('/admin/settings');
    expect(read.status).toBe(200);
    expect(read.body.settings.email_provider).toBe('postmark');
  });

  it('rejects an invalid emailProvider value at the schema layer', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const res = await admin
      .patch('/admin/settings')
      .send({ emailProvider: 'sendgrid-not-supported' });
    expect(res.status).toBe(400);
  });

  it('pre-flight rejects switching emailProvider when required secrets are missing', async () => {
    // With no Postmark server_token stored, switching to postmark should 400
    // with a clear "provider_secrets_missing" error listing the gap so the
    // admin can fix it in one pass rather than silently breaking outbound.
    const { db } = await import('../db/knex.js');
    await db('firm_provider_credentials').delete();
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const res = await admin.patch('/admin/settings').send({ emailProvider: 'postmark' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('provider_secrets_missing');
    expect(res.body.missing).toEqual([
      {
        field: 'emailProvider',
        provider: 'postmark',
        keys: ['email.postmark.server_token'],
      },
    ]);
  });

  it('pre-flight rejects switching to emailit when api_key is missing', async () => {
    const { db } = await import('../db/knex.js');
    await db('firm_provider_credentials').delete();
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const res = await admin.patch('/admin/settings').send({ emailProvider: 'emailit' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('provider_secrets_missing');
    expect(res.body.missing).toEqual([
      {
        field: 'emailProvider',
        provider: 'emailit',
        keys: ['email.emailit.api_key'],
      },
    ]);
  });

  it('PATCH /admin/settings persists emailit once api_key is stored', async () => {
    const { set: setProviderSecret } = await import('../services/providerSecrets.js');
    await setProviderSecret('email.emailit.api_key', 'test-emailit-key-xyz', null);
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const patched = await admin.patch('/admin/settings').send({ emailProvider: 'emailit' });
    expect(patched.status).toBe(200);
    const read = await admin.get('/admin/settings');
    expect(read.body.settings.email_provider).toBe('emailit');
  });

  describe('Admin → Providers test endpoints', () => {
    it('POST /admin/providers/test/email rejects with provider_secrets_missing when emailit has no api_key', async () => {
      const { db } = await import('../db/knex.js');
      await db('firm_provider_credentials').delete();
      const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const res = await admin
        .post('/admin/providers/test/email')
        .send({ provider: 'emailit', to: 'admin@example.com' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('provider_secrets_missing');
      expect(res.body.keys).toEqual(['email.emailit.api_key']);
    });

    it('POST /admin/providers/test/sms rejects with provider_secrets_missing when textlink has no api_key', async () => {
      const { db } = await import('../db/knex.js');
      await db('firm_provider_credentials').delete();
      const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const res = await admin
        .post('/admin/providers/test/sms')
        .send({ provider: 'textlink', to: '+15551234567' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('provider_secrets_missing');
    });

    it('POST /admin/providers/test/email with mock provider always succeeds + writes audit row', async () => {
      const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const res = await admin
        .post('/admin/providers/test/email')
        .send({ provider: 'mock', to: 'admin@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.providerMessageId).toMatch(/^mock-/);
      // Audit row should land.
      const { db } = await import('../db/knex.js');
      const row = await db('audit_log')
        .where({ action: 'admin.provider_test_sent' })
        .orderBy('created_at', 'desc')
        .first();
      expect(row).toBeDefined();
      expect(row.details.provider).toBe('mock');
      expect(row.details.status).toBe('sent');
    });

    it('rejects validation errors (bad email, bad provider enum)', async () => {
      const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const bad1 = await admin
        .post('/admin/providers/test/email')
        .send({ provider: 'emailit', to: 'not-an-email' });
      expect(bad1.status).toBe(400);
      const bad2 = await admin
        .post('/admin/providers/test/email')
        .send({ provider: 'sendgrid', to: 'admin@example.com' });
      expect(bad2.status).toBe(400);
    });

    it('non-admin (staff) is forbidden from hitting the test endpoint', async () => {
      const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
      const res = await alice
        .post('/admin/providers/test/email')
        .send({ provider: 'mock', to: 'admin@example.com' });
      expect(res.status).toBe(403);
    });
  });
});

afterAll(async () => {
  const { db } = await import('../db/knex.js');
  await db.destroy();
});
