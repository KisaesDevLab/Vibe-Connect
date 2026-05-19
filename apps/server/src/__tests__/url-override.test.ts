/**
 * Integration tests for the admin-settable SITE_URL / PORTAL_URL override.
 *
 * Covers:
 *   - effectiveUrls() falls back to env when DB columns are null/empty/whitespace
 *   - effectiveUrls() returns DB value when populated
 *   - PATCH /admin/settings rejects malformed URLs with the right field-scoped error
 *   - PATCH /admin/settings refuses the dev-default placeholder
 *   - PATCH /admin/settings persists a valid override and /__vibe-boot.js reflects it
 *   - Null clears the override and the env value comes back
 *   - Tokenized intake link POST uses the DB-overridden portal URL (intake
 *     is client-facing and reads portalUrl, not siteUrl — the appliance
 *     deploys staff and client portals on different subdomains)
 *   - Client invite link uses the DB portal_url override
 *
 * Seeded users (apps/server/src/db/seeds/01_groups_and_users.js):
 *   alice  / alice-dev-only-ChangeMe!  (non-admin)
 *   kurt   / kurt-dev-only-ChangeMe!   (admin)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { resetTestDb } from './test-helpers.js';
import { __resetIntakeCryptoCache } from '../services/intakeCrypto.js';

let app: Express;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  if (!process.env.CONNECT_INTAKE_ENCRYPTION_KEY) {
    process.env.CONNECT_INTAKE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
  __resetIntakeCryptoCache();
  await resetTestDb();
  const mod = await import('../app.js');
  app = mod.createApp();
}, 120_000);

afterAll(async () => {
  // Leave the shared pool open — file-level teardown only matters when a
  // test mutates pool state, which we don't here.
});

beforeEach(async () => {
  const { db } = await import('../db/knex.js');
  // Clear overrides so each case starts from "env defaults take effect".
  await db('firm_settings').where({ id: 1 }).update({ site_url: null, portal_url: null });
  // Also clear intake_links so per-mint assertions don't see leftovers.
  await db('intake_links').del();
});

type TestAgent = ReturnType<typeof request.agent>;
async function loginAs(username: string, password: string): Promise<TestAgent> {
  const agent = request.agent(app);
  const r = await agent.post('/auth/login').send({ username, password });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return agent;
}

// Convenience: read the JS payload of /__vibe-boot.js and extract the
// embedded JSON literal so we can assert on the boot config the SPA sees.
async function readBoot(): Promise<{ siteUrl: string; portalUrl: string }> {
  const r = await request(app).get('/__vibe-boot.js');
  expect(r.status).toBe(200);
  // Payload shape: `window.__VIBE_BOOT__ = { ... };`
  const match = /window\.__VIBE_BOOT__ = (\{[\s\S]*\});/.exec(r.text);
  if (!match) throw new Error(`unexpected boot payload: ${r.text}`);
  return JSON.parse(match[1]!) as { siteUrl: string; portalUrl: string };
}

// Same as readBoot but with a configurable Host header — exercises the
// host-aware basePath derivation in routes/bootstrap.ts.
async function readBootWithHost(
  host: string,
): Promise<{ basePath: string; siteUrl: string; portalUrl: string }> {
  const r = await request(app).get('/__vibe-boot.js').set('Host', host);
  expect(r.status).toBe(200);
  const match = /window\.__VIBE_BOOT__ = (\{[\s\S]*\});/.exec(r.text);
  if (!match) throw new Error(`unexpected boot payload: ${r.text}`);
  return JSON.parse(match[1]!) as { basePath: string; siteUrl: string; portalUrl: string };
}

describe('effectiveUrls() helper', () => {
  it('falls back to env when DB columns are null', async () => {
    const { effectiveUrls } = await import('../services/effectiveUrls.js');
    const r = await effectiveUrls();
    expect(r.dbSiteUrl).toBeNull();
    expect(r.dbPortalUrl).toBeNull();
    expect(r.siteUrl).toBe(r.envSiteUrl);
    expect(r.portalUrl).toBe(r.envPortalUrl);
  });

  it('falls back to env when DB columns are whitespace-only', async () => {
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({ site_url: '   ', portal_url: '\n\t' });
    const { effectiveUrls } = await import('../services/effectiveUrls.js');
    const r = await effectiveUrls();
    expect(r.dbSiteUrl).toBeNull();
    expect(r.dbPortalUrl).toBeNull();
    expect(r.siteUrl).toBe(r.envSiteUrl);
  });

  it('returns DB value (trimmed) when populated', async () => {
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({
      site_url: '  https://vibe.cpa2web.app/connect  ',
      portal_url: 'https://vibe.cpa2web.app/connect/portal',
    });
    const { effectiveUrls } = await import('../services/effectiveUrls.js');
    const r = await effectiveUrls();
    expect(r.dbSiteUrl).toBe('https://vibe.cpa2web.app/connect');
    expect(r.dbPortalUrl).toBe('https://vibe.cpa2web.app/connect/portal');
    expect(r.siteUrl).toBe('https://vibe.cpa2web.app/connect');
    expect(r.portalUrl).toBe('https://vibe.cpa2web.app/connect/portal');
  });
});

describe('PATCH /admin/settings — URL validation', () => {
  it('rejects malformed URLs', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await admin.patch('/admin/settings').send({ siteUrl: 'not a url at all' });
    expect(r.status).toBe(400);
    expect(r.body.field).toBe('siteUrl');
    expect(r.body.reason).toBe('invalid_url');
  });

  it('rejects non-http(s) schemes', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await admin.patch('/admin/settings').send({ siteUrl: 'javascript:alert(1)' });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe('bad_scheme');
  });

  it('rejects plain http for non-loopback hosts', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await admin
      .patch('/admin/settings')
      .send({ siteUrl: 'http://vibe.cpa2web.app/connect' });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe('http_only_allowed_for_localhost');
  });

  it('allows plain http for localhost (dev use)', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await admin.patch('/admin/settings').send({ siteUrl: 'http://localhost:8080' });
    expect(r.status).toBe(200);
  });

  it('rejects ?query and #fragment', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const q = await admin
      .patch('/admin/settings')
      .send({ siteUrl: 'https://vibe.cpa2web.app/connect?foo=bar' });
    expect(q.status).toBe(400);
    expect(q.body.reason).toBe('query_not_allowed');
    const f = await admin
      .patch('/admin/settings')
      .send({ portalUrl: 'https://vibe.cpa2web.app/connect/portal#frag' });
    expect(f.status).toBe(400);
    expect(f.body.reason).toBe('fragment_not_allowed');
  });

  it('refuses the dev-default placeholder (the foot-gun case)', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await admin.patch('/admin/settings').send({ siteUrl: 'http://localhost:4000' });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe('dev_default_not_allowed');
  });

  it('non-admin cannot PATCH', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice
      .patch('/admin/settings')
      .send({ siteUrl: 'https://vibe.cpa2web.app/connect' });
    expect(r.status).toBe(403);
  });
});

describe('Host-aware basePath derivation', () => {
  it('emits basePath="" (not "/") when the Host matches a root-mounted portal URL', async () => {
    // CRITICAL regression guard: the apps/{web,portal,intake}/lib/boot.ts
    // url() helper does `base + path`. If the server returns basePath="/"
    // for a root-mounted host, the helper produces "//api/foo", which a
    // browser parses as protocol-relative and tries to DNS-resolve `api`
    // — the entire staff/client list fetch dies with ERR_NAME_NOT_RESOLVED.
    // Empty string is the right value here; React Router accepts "" as a
    // basename and url() short-circuits on falsy base.
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    await admin.patch('/admin/settings').send({
      siteUrl: 'https://vibe.cpa2web.app/connect',
      portalUrl: 'https://client.cpa2web.app',
    });

    const portalBoot = await readBootWithHost('client.cpa2web.app');
    expect(portalBoot.basePath).toBe('');

    const staffBoot = await readBootWithHost('vibe.cpa2web.app');
    expect(staffBoot.basePath).toBe('/connect');
  });
});

describe('PATCH → /__vibe-boot.js round-trip', () => {
  it('save persists and /__vibe-boot.js reflects the override; null clears it', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    // Save override.
    const save = await admin.patch('/admin/settings').send({
      siteUrl: 'https://vibe.cpa2web.app/connect',
      portalUrl: 'https://vibe.cpa2web.app/connect/portal',
    });
    expect(save.status).toBe(200);
    const after = await readBoot();
    expect(after.siteUrl).toBe('https://vibe.cpa2web.app/connect');
    expect(after.portalUrl).toBe('https://vibe.cpa2web.app/connect/portal');

    // Clear override → env defaults come back.
    const clear = await admin.patch('/admin/settings').send({ siteUrl: null, portalUrl: null });
    expect(clear.status).toBe(200);
    const after2 = await readBoot();
    // env.siteUrl defaults to http://localhost:4000 unless the test runner
    // overrides it; just assert it's NOT the override anymore.
    expect(after2.siteUrl).not.toBe('https://vibe.cpa2web.app/connect');
    expect(after2.portalUrl).not.toBe('https://vibe.cpa2web.app/connect/portal');
  });

  it('GET /admin/settings surfaces env defaults + effective values alongside the row', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await admin.get('/admin/settings');
    expect(r.status).toBe(200);
    expect(r.body.envSiteUrl).toEqual(expect.any(String));
    expect(r.body.envPortalUrl).toEqual(expect.any(String));
    expect(r.body.effectiveSiteUrl).toEqual(expect.any(String));
    expect(r.body.effectivePortalUrl).toEqual(expect.any(String));
    expect(r.body.settings).toBeDefined();
  });
});

describe('Cross-cutting: outbound URLs respect the DB override', () => {
  it('tokenized intake link mint uses the DB-overridden portal URL', async () => {
    // Intake links are CLIENT-facing: the recipient is the client, not
    // staff. The appliance deploys Vibe-Connect with the staff portal
    // at one subdomain (e.g. vibe.<domain>/connect) and the client
    // portal at another (e.g. client.<domain>). intakeAdmin.ts reads
    // effectiveUrls().portalUrl — not siteUrl — so the share-with-
    // client URL points at the host the client can actually reach
    // (siteUrl would auth-gate them into the staff login screen).
    // Set the portal-URL override and assert the minted link honors
    // it. Also set siteUrl to a clearly different value to prove the
    // intake mint is NOT reading siteUrl by accident.
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const save = await admin.patch('/admin/settings').send({
      siteUrl: 'https://vibe.cpa2web.app/connect',
      portalUrl: 'https://client.cpa2web.app',
    });
    expect(save.status).toBe(200);

    // Mint a tokenized link.
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const mint = await alice
      .post('/admin/intake/links')
      .send({ email: 'client@example.com', expiresIn: '24h' });
    expect(mint.status).toBe(201);
    expect(mint.body.link.url).toMatch(/^https:\/\/client\.cpa2web\.app\/intake\/t\//);
    // Defensive: ensure the staff host did NOT sneak into the URL.
    expect(mint.body.link.url).not.toMatch(/vibe\.cpa2web\.app\/connect\/intake/);
  });

  it('client invite email body contains the DB-overridden portal URL', async () => {
    // Set override.
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const save = await admin.patch('/admin/settings').send({
      portalUrl: 'https://vibe.cpa2web.app/connect/portal',
    });
    expect(save.status).toBe(200);

    // Send a client invite. The mock email provider writes outbound to
    // .outbox/email/<file>.txt so we can grep the body for the URL.
    const { db } = await import('../db/knex.js');
    await db('external_identities').del();
    const env = await import('../env.js');
    const outboxDir = path.resolve(env.env.outboxDir, 'email');
    // Best-effort cleanup so this test doesn't read a stale file from a
    // prior run.
    await fs.rm(outboxDir, { recursive: true, force: true }).catch(() => {});

    const invite = await admin.post('/clients/invite').send({
      displayName: 'Override Subject',
      channels: {
        email: { enabled: true, value: 'override-subject@cfhcpa.test' },
        sms: { enabled: false, value: null },
      },
      verification: { type: 'none' },
    });
    expect(invite.status).toBe(201);
    expect(invite.body.deliveryStatus.email).toBe('sent');

    // Read the most recent email file, assert the override URL is in it.
    const files = await fs.readdir(outboxDir).catch(() => [] as string[]);
    expect(files.length).toBeGreaterThan(0);
    const latest = files.sort().slice(-1)[0]!;
    const body = await fs.readFile(path.join(outboxDir, latest), 'utf8');
    expect(body).toMatch(/https:\/\/vibe\.cpa2web\.app\/connect\/portal\/invite\?id=/);
    // And explicitly does NOT carry the localhost default.
    expect(body).not.toMatch(/http:\/\/localhost:4000\/invite/);
  });
});
