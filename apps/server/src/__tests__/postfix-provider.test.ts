/**
 * PostfixProvider — guards around the SMTP send path that the e2e test
 * suites don't exercise (they all run against the mock provider). Covers
 * the partial-auth XOR refusal so a typo in Admin → Providers doesn't
 * silently fall back to an unauthenticated relay session.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  await db('firm_settings').where({ id: 1 }).update({ email_provider: 'postfix' });
});

describe('PostfixProvider', () => {
  it('refuses to build a transport when only smtp.user is configured', async () => {
    const { set } = await import('../services/providerSecrets.js');
    await set('email.smtp.host', 'smtp.example.com', null);
    await set('email.smtp.port', '587', null);
    await set('email.smtp.user', 'alice@example.com', null);
    // intentionally NO email.smtp.pass

    const { getEmailProvider } = await import('../bridges/email/index.js');
    const provider = await getEmailProvider();
    expect(provider.name).toBe('postfix');
    await expect(provider.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow(
      /smtp_partial_auth_configured/,
    );
  });

  it('refuses to build a transport when only smtp.pass is configured', async () => {
    const { set } = await import('../services/providerSecrets.js');
    await set('email.smtp.host', 'smtp.example.com', null);
    await set('email.smtp.port', '587', null);
    await set('email.smtp.pass', 'p@ssw0rd', null);
    // intentionally NO email.smtp.user

    const { getEmailProvider } = await import('../bridges/email/index.js');
    const provider = await getEmailProvider();
    await expect(provider.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow(
      /smtp_partial_auth_configured/,
    );
  });

  it('throws SMTP_HOST is required when host is missing', async () => {
    const { getEmailProvider } = await import('../bridges/email/index.js');
    const provider = await getEmailProvider();
    await expect(provider.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow(
      /SMTP_HOST is required/,
    );
  });
});

afterAll(async () => {
  const { db } = await import('../db/knex.js');
  await db.destroy();
});
