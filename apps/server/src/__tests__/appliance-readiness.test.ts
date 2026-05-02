/**
 * Phase A appliance-readiness integration tests.
 *
 * Covers the gap-fillers added in this update for the standalone +
 * appliance dual-mode story. Each describe block names its phase A
 * subtask so a regression triages back to the right plan item.
 *
 * Note: this file shares the test DB pool with `distribution-config.test.ts`
 * and follows the same `vi.resetModules()` + `loadApp()` pattern.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { resetTestDb } from './test-helpers.js';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
  // The default seed doesn't run /install, so firm_keys is empty after a
  // fresh resetTestDb. Several A-block tests need an "installed" appliance
  // to assert against (fingerprint, installed:true, key-status with
  // populated firmKey). Insert a deterministic dummy row so the test
  // shape matches a post-/install appliance without dragging the whole
  // crypto wrapping flow into a unit test.
  const { db } = await import('../db/knex.js');
  const existing = await db('firm_keys').whereNull('retired_at').first('id');
  if (!existing) {
    await db('firm_keys').insert({
      public_key: 'test-public-key-placeholder',
      encrypted_recovery_private_key: 'test-wrapped-private-placeholder',
      kdf_params: { kind: 'blake2b' },
      kdf_salt: 'test-salt',
      rotation_version: 1,
    });
  }
}, 120_000);

afterAll(async () => {
  // Clean up the test firm_keys row so sibling test files that assume
  // an empty firm_keys table aren't disturbed.
  const { db } = await import('../db/knex.js');
  await db('firm_keys').where({ public_key: 'test-public-key-placeholder' }).delete();
  // Also clear settings my tests wrote so provider-selection / others
  // start clean.
  await db('firm_settings')
    .where({ id: 1 })
    .update({
      last_backup_ok_at: null,
      last_backup_recorded_at: null,
      last_backup_status: null,
    });
});

beforeEach(() => {
  // Reset env knobs each block sets, otherwise the prior block's TLS_MODE
  // / BACKUP_REQUIRED / ALLOWED_ORIGIN bleeds through (env.ts memoizes).
  delete process.env.BASE_PATH;
  delete process.env.SESSION_COOKIE_PATH;
  delete process.env.TLS_MODE;
  delete process.env.SESSION_SECURE;
  delete process.env.ALLOWED_ORIGIN;
  delete process.env.BACKUP_REQUIRED;
  delete process.env.BACKUP_HEARTBEAT_TOKEN;
  delete process.env.EMAIL_PROVIDER;
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECURE = 'false';
});

async function loadApp(envOverrides: Record<string, string>): Promise<Express> {
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  vi.resetModules();
  const mod = await import('../app.js');
  return mod.createApp();
}

async function loginAs(
  app: Express,
  username: string,
  password: string,
): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app);
  const r = await agent.post('/auth/login').send({ username, password });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  return agent;
}

describe('A.1 — /ping liveness probe', () => {
  it('returns 200 ok with no body fields beyond ok', async () => {
    const app = await loadApp({});
    const r = await request(app).get('/ping');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('does not require auth', async () => {
    // /ping is a load-balancer probe — must answer without a session
    // cookie or any auth header. The skip list in app.ts also exempts it
    // from the global rate limiter.
    const app = await loadApp({});
    const r = await request(app).get('/ping').set('Cookie', '');
    expect(r.status).toBe(200);
  });
});

describe('A.1 — /health readiness probe', () => {
  it('returns 200 with installed:true once firm_keys row exists', async () => {
    const app = await loadApp({});
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.service).toBe('vibe-connect-server');
    // The seed inserts a firm_keys row, so installed:true after resetTestDb.
    expect(r.body.installed).toBe(true);
  });
});

describe('A.3 — ALLOWED_ORIGIN CORS allow-list', () => {
  it('reflect-origin behavior when ALLOWED_ORIGIN is unset (default)', async () => {
    const app = await loadApp({});
    const r = await request(app)
      .get('/health')
      .set('Origin', 'https://random.example.com');
    expect(r.status).toBe(200);
    // CORS reflected the origin back; cors() default with credentials:true
    // emits Access-Control-Allow-Origin: <origin>.
    expect(r.headers['access-control-allow-origin']).toBe('https://random.example.com');
  });

  it('allows literal origin from comma-separated list', async () => {
    const app = await loadApp({
      ALLOWED_ORIGIN: 'https://connect.firm.com,https://other.firm.com',
    });
    const r = await request(app)
      .get('/health')
      .set('Origin', 'https://connect.firm.com');
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('https://connect.firm.com');
  });

  it('rejects origin not on the list', async () => {
    const app = await loadApp({
      ALLOWED_ORIGIN: 'https://connect.firm.com',
    });
    const r = await request(app)
      .get('/health')
      .set('Origin', 'https://evil.example.com');
    // The cors() middleware passes an Error to express's error handler;
    // app.ts:err-middleware returns 500 with internal_error. The exact
    // status code is less important than confirming the origin header
    // wasn't echoed.
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('honors regex: prefixed entries', async () => {
    const app = await loadApp({
      ALLOWED_ORIGIN: 'regex:^https://[a-z]+\\.firm\\.com$',
    });
    const r1 = await request(app)
      .get('/health')
      .set('Origin', 'https://staff.firm.com');
    expect(r1.headers['access-control-allow-origin']).toBe('https://staff.firm.com');
    const r2 = await request(app)
      .get('/health')
      .set('Origin', 'https://staff.evil.com');
    expect(r2.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('same-origin (no Origin header) always passes', async () => {
    const app = await loadApp({
      ALLOWED_ORIGIN: 'https://connect.firm.com',
    });
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
  });
});

describe('A.7 — /admin/key-status', () => {
  it('returns firm-key fingerprint + backup state', async () => {
    const app = await loadApp({ BACKUP_REQUIRED: 'false' });
    const agent = await loginAs(app, 'kurt', 'kurt-dev-only-ChangeMe!');
    const r = await agent.get('/admin/key-status');
    expect(r.status).toBe(200);
    expect(r.body.firmKey.installed).toBe(true);
    // 16-char hex fingerprint = 8 bytes truncated SHA-256.
    expect(r.body.firmKey.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof r.body.firmKey.rotationVersion).toBe('number');
    expect(r.body.backup.required).toBe(false);
    expect(r.body.backup.warnDays).toBe(7);
    expect(r.body.backup.blockDays).toBe(30);
    // Fresh test DB has no backup heartbeat — state is 'never'.
    expect(r.body.backup.state).toBe('never');
    expect(r.body.backup.lastOkAt).toBeNull();
  });

  it('refuses non-admin callers', async () => {
    const app = await loadApp({ BACKUP_REQUIRED: 'false' });
    const r = await request(app).get('/admin/key-status');
    expect([401, 403]).toContain(r.status);
  });
});

describe('A.7 — /admin/backup-heartbeat', () => {
  const TOKEN = 'a'.repeat(64);

  it('rejects without bearer', async () => {
    const app = await loadApp({
      BACKUP_REQUIRED: 'true',
      BACKUP_HEARTBEAT_TOKEN: TOKEN,
    });
    const r = await request(app).post('/admin/backup-heartbeat').send({ ok: true });
    expect(r.status).toBe(401);
  });

  it('rejects with wrong token (timing-safe compare)', async () => {
    const app = await loadApp({
      BACKUP_REQUIRED: 'true',
      BACKUP_HEARTBEAT_TOKEN: TOKEN,
    });
    const r = await request(app)
      .post('/admin/backup-heartbeat')
      .set('Authorization', `Bearer ${'b'.repeat(64)}`)
      .send({ ok: true });
    expect(r.status).toBe(401);
  });

  it('accepts valid token and updates firm_settings.last_backup_ok_at', async () => {
    const app = await loadApp({
      BACKUP_REQUIRED: 'true',
      BACKUP_HEARTBEAT_TOKEN: TOKEN,
    });
    const r = await request(app)
      .post('/admin/backup-heartbeat')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ ok: true, status: { rows: 12345, bytes: 999 } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // Verify the row updated.
    const { db } = await import('../db/knex.js');
    const row = await db('firm_settings')
      .where({ id: 1 })
      .first('last_backup_ok_at', 'last_backup_status');
    expect(row?.last_backup_ok_at).toBeTruthy();
    expect(row?.last_backup_status).toEqual({ rows: 12345, bytes: 999 });
  });

  it('after heartbeat, /admin/key-status reports state=ok', async () => {
    const app = await loadApp({
      BACKUP_REQUIRED: 'true',
      BACKUP_HEARTBEAT_TOKEN: TOKEN,
    });
    await request(app)
      .post('/admin/backup-heartbeat')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ ok: true });
    const agent = await loginAs(app, 'kurt', 'kurt-dev-only-ChangeMe!');
    const r = await agent.get('/admin/key-status');
    expect(r.status).toBe(200);
    expect(r.body.backup.state).toBe('ok');
    expect(r.body.backup.daysSinceBackup).toBe(0);
  });
});

describe('A.8 — EMAIL_PROVIDER=none graceful disable', () => {
  it('boot succeeds + getEmailProvider returns NoneProvider', async () => {
    // Direct unit-style assertion: with EMAIL_PROVIDER=none the resolver
    // short-circuits before the DB lookup, so we don't need a live DB
    // beyond what the test pool already provides.
    //
    // Vitest runs the whole server suite in a single fork
    // (vitest.config.ts pool: forks/singleFork), so process.env mutations
    // bleed across files unless we tear them down explicitly. The
    // `try/finally` resets EMAIL_PROVIDER + the bridge module cache so
    // sibling tests (e.g. provider-selection.test.ts) see the original
    // 'mock' default.
    const original = process.env.EMAIL_PROVIDER;
    try {
      process.env.EMAIL_PROVIDER = 'none';
      vi.resetModules();
      const { getEmailProvider } = await import('../bridges/email/index.js');
      const provider = await getEmailProvider();
      expect(provider.name).toBe('none');
      const result = await provider.send({
        to: 'someone@example.com',
        subject: 'test',
        text: 'body',
      });
      expect(result.status).toBe('sent');
    } finally {
      if (original === undefined) delete process.env.EMAIL_PROVIDER;
      else process.env.EMAIL_PROVIDER = original;
      vi.resetModules();
    }
  });
});
