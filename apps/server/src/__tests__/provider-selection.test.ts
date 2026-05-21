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
  // Reset providers to mock + clear any DB email_from override so tests
  // start from a clean baseline. The email_from column was added in
  // 20260520000003 — leaving stale state would let an earlier test's
  // placeholder save bleed into a later test's "uses env fallback" check.
  await db('firm_settings')
    .where({ id: 1 })
    .update({ sms_provider: 'mock', email_provider: 'mock', email_from: null });
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

    it('Test SMS accepts a bare US 10-digit number (E.164-normalised server-side)', async () => {
      // Regression for v0.4.23: the prior normalisation just stripped
      // formatting and prepended `+`, turning a bare `4175554645` into
      // `+4175554645` — country code 4 doesn't exist. The endpoint now
      // adds the `+1` country prefix for US 10-digit input.
      const { set: setProviderSecret } = await import('../services/providerSecrets.js');
      await setProviderSecret('sms.textlink.api_key', 'test-tl-key', null);
      const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const res = await admin
        .post('/admin/providers/test/sms')
        .send({ provider: 'mock', to: '4175554645' });
      // Mock provider always succeeds — assertion here is that we
      // didn't reject with `invalid_phone` on the unprefixed input.
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('Test SMS rejects un-parseable phone input with invalid_phone', async () => {
      const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      // 16 digits passes the zod min(7)/max(20) shape check but exceeds
      // E.164's 15-digit limit — the normalizer returns null and the
      // route surfaces `invalid_phone` (rather than the generic
      // `validation` zod error) so the UI can show a useful message.
      const res = await admin
        .post('/admin/providers/test/sms')
        .send({ provider: 'mock', to: '1234567890123456' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_phone');
    });

    it('GET /admin/settings exposes envEmailFrom alongside settings.email_from', async () => {
      // The UI needs both to render a "currently overriding X, env
      // default is Y" affordance under the Sender address field.
      const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const res = await admin.get('/admin/settings');
      expect(res.status).toBe(200);
      expect(typeof res.body.envEmailFrom).toBe('string');
      expect(res.body.envEmailFrom.length).toBeGreaterThan(0);
      // beforeEach cleared email_from → DB column should be null.
      expect(res.body.settings.email_from).toBeNull();
    });

    it('PATCH /admin/settings persists emailFrom and clears it on null', async () => {
      const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const set1 = await admin
        .patch('/admin/settings')
        .send({ emailFrom: 'Acme CPA <ops@acme-verified.com>' });
      expect(set1.status).toBe(200);
      const read1 = await admin.get('/admin/settings');
      expect(read1.body.settings.email_from).toBe('Acme CPA <ops@acme-verified.com>');

      const clear = await admin.patch('/admin/settings').send({ emailFrom: null });
      expect(clear.status).toBe(200);
      const read2 = await admin.get('/admin/settings');
      expect(read2.body.settings.email_from).toBeNull();
    });

    it('PATCH /admin/settings rejects the bundled placeholder', async () => {
      // An operator pasting EMAIL_FROM verbatim from the .env.example
      // would otherwise save the same value they are trying to fix. Loud
      // 400 with a field-tagged reason so the UI can show useful copy.
      const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const res = await admin
        .patch('/admin/settings')
        .send({ emailFrom: 'Vibe Connect <noreply@vibeconnect.local>' });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('emailFrom');
      expect(res.body.reason).toBe('placeholder_rejected');
    });

    it('PATCH /admin/settings rejects an address with no @', async () => {
      const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const res = await admin.patch('/admin/settings').send({ emailFrom: 'just-a-string' });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('emailFrom');
      expect(res.body.reason).toBe('missing_at_sign');
    });

    it('PATCH /admin/settings trims whitespace and treats empty as clear', async () => {
      const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      // Seed a value then send only whitespace; should reset to null.
      await admin.patch('/admin/settings').send({ emailFrom: 'ops@acme-verified.com' });
      const blank = await admin.patch('/admin/settings').send({ emailFrom: '   ' });
      expect(blank.status).toBe(200);
      const read = await admin.get('/admin/settings');
      expect(read.body.settings.email_from).toBeNull();
    });

    it('SMTP pre-flight requires only host — port has an env default (regression for v0.4.21)', async () => {
      // User reported on v0.4.20: configuring SMTP host + password, then
      // clicking Test, surfaced "Missing credentials: email.smtp.port".
      // Port has an env default (587) so it's not actually required for
      // the bridge to function. Only HOST is required up-front.
      const { db } = await import('../db/knex.js');
      const { set: setProviderSecret } = await import('../services/providerSecrets.js');
      await db('firm_provider_credentials').delete();
      await setProviderSecret('email.smtp.host', 'smtp.example.com', null);
      // intentionally NO email.smtp.port stored.
      const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const res = await admin
        .post('/admin/providers/test/email')
        .send({ provider: 'postfix', to: 'admin@example.com' });
      // The send will still fail at the actual SMTP-connect step
      // (smtp.example.com doesn't exist), but it should NOT fail with
      // `provider_secrets_missing` for port.
      expect(res.body.error).not.toBe('provider_secrets_missing');
    });
  });
});

afterAll(async () => {
  const { db } = await import('../db/knex.js');
  await db.destroy();
});
