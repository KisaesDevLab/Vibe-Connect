/**
 * Regression: the portal session cookie's `path=` must be derived from
 * the request's Host (matched against firm_settings.portal_url /
 * site_url), NOT pinned globally to env.sessionCookiePath.
 *
 * The user-reported symptom: on a multi-subdomain appliance the staff
 * app lives at vibe.<domain>/connect/ (so SESSION_COOKIE_PATH=/connect)
 * AND the portal lives at client.<domain>/ — the cookie inherited the
 * /connect scope, the browser refused to send it back for /portal/*
 * requests, every /portal/me 401'd, and clients couldn't log in even
 * with a correct access code.
 *
 * This test seeds a code via the access-codes service, POSTs /verify
 * with the host header set to client.<domain>, and asserts the
 * Set-Cookie response carries Path=/ — independent of what
 * env.sessionCookiePath was (the env value still applies to root-host
 * fallbacks).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
}, 120_000);

beforeEach(async () => {
  const { db } = await import('../db/knex.js');
  await db('client_sessions').del();
  await db('access_codes').del();
  await db('external_identities').del();
});

async function seedClientWithCode(): Promise<{
  email: string;
  code: string;
  identityId: string;
}> {
  const { db } = await import('../db/knex.js');
  const { issueAccessCode } = await import('../services/accessCodes.js');
  const email = `verify-${Date.now()}@example.com`;
  const [row] = await db('external_identities')
    .insert({
      email,
      display_name: 'Verify Tester',
      verification_type: 'none',
      verification_required: false,
    })
    .returning([
      'id',
      'email',
      'phone',
      'display_name',
      'verification_type',
      'verification_last4_hash',
      'verification_required',
      'deactivated_at',
    ]);
  const { code } = await issueAccessCode(
    {
      id: row.id as string,
      email: row.email as string,
      phone: (row.phone as string | null) ?? null,
      display_name: row.display_name as string,
      verification_type: row.verification_type as 'ssn' | 'ein' | 'none',
      verification_last4_hash: (row.verification_last4_hash as string | null) ?? null,
      verification_required: row.verification_required as boolean,
      deactivated_at: (row.deactivated_at as string | null) ?? null,
    },
    'email',
  );
  return { email, code, identityId: row.id as string };
}

function pathFromSetCookie(raw: string | string[] | undefined): string | null {
  if (!raw) return null;
  const headers = Array.isArray(raw) ? raw : [raw];
  for (const h of headers) {
    if (!/^vibe\.portal=/.test(h)) continue;
    const m = /Path=([^;]+)/i.exec(h);
    if (m) return m[1] ?? null;
  }
  return null;
}

describe('portal verify cookie path is host-derived', () => {
  it('Host=client.<domain> with portalUrl pointing there → Path=/', async () => {
    // The multi-subdomain case the user hit. Set portal_url so
    // effectiveUrls() matches the request's Host and derives `/`.
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({
      site_url: 'https://vibe.cpa2web.app/connect',
      portal_url: 'https://client.cpa2web.app',
    });
    const { email, code } = await seedClientWithCode();
    const res = await request(app)
      .post('/portal/verify')
      .set('Host', 'client.cpa2web.app')
      .send({ identifier: email, code, sessionPublicKey: 'pk' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const cookiePath = pathFromSetCookie(res.headers['set-cookie']);
    expect(cookiePath).toBe('/');
  });

  it('Host=vibe.<domain> with siteUrl pointing to /connect → Path=/connect', async () => {
    // The staff-host case. The same /verify endpoint can also fire on
    // the staff subdomain (e.g. staff impersonating a portal session
    // during dev) — the cookie should land at /connect there.
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({
      site_url: 'https://vibe.cpa2web.app/connect',
      portal_url: 'https://client.cpa2web.app',
    });
    const { email, code } = await seedClientWithCode();
    const res = await request(app)
      .post('/portal/verify')
      .set('Host', 'vibe.cpa2web.app')
      .send({ identifier: email, code, sessionPublicKey: 'pk' });
    expect(res.status).toBe(200);
    const cookiePath = pathFromSetCookie(res.headers['set-cookie']);
    expect(cookiePath).toBe('/connect');
  });

  it('Host that matches neither portalUrl nor siteUrl falls back to env default', async () => {
    // Localhost / dev-test request — fall back to env.sessionCookiePath
    // (defaults to "/").
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({
      site_url: 'https://vibe.cpa2web.app/connect',
      portal_url: 'https://client.cpa2web.app',
    });
    const { email, code } = await seedClientWithCode();
    const res = await request(app)
      .post('/portal/verify')
      .set('Host', 'localhost:4000')
      .send({ identifier: email, code, sessionPublicKey: 'pk' });
    expect(res.status).toBe(200);
    const cookiePath = pathFromSetCookie(res.headers['set-cookie']);
    // Env default is '/' in the test environment.
    expect(cookiePath).toBe('/');
  });
});
