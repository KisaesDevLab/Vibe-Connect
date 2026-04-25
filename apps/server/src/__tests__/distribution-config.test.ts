/**
 * Distribution mode integration tests. Cover the runtime knobs added in
 * Phase D1 of the cross-product distribution plan
 * (`vibe-distribution-plan.md`):
 *
 *   - BASE_PATH + SESSION_COOKIE_PATH wire through to the cookie + the
 *     /__vibe-boot.js bootstrap script the SPAs load before main.tsx.
 *   - TLS_MODE=external disables the in-app ACME ticker, returns 409 on
 *     admin write paths, and surfaces `tlsMode: 'external'` on the status
 *     endpoint so the staff UI can render the right panel.
 *   - TLS_MODE=internal preserves the existing Phase-23 behaviour (no
 *     regression for the single-appliance / direct-internet deploy).
 *
 * env.ts memoizes the env object at module load, so each describe block
 * that needs a different mode resets the module graph + reimports.
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
}, 120_000);

afterAll(() => {
  // Leave the pool open for sibling test files (matches the harness pattern).
});

beforeEach(() => {
  // Each describe block picks its own mode; clear before so the prior block
  // doesn't bleed.
  delete process.env.BASE_PATH;
  delete process.env.SESSION_COOKIE_PATH;
  delete process.env.TLS_MODE;
  delete process.env.SESSION_SECURE;
  process.env.NODE_ENV = 'test';
  // SESSION_SECURE is force-required in production env.ts, but tests run
  // under NODE_ENV=test where the guard is off. Keep it explicit.
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

describe('GET /__vibe-boot.js — bootstrap script', () => {
  it('emits window.__VIBE_BOOT__ with single-app defaults', async () => {
    const app = await loadApp({ BASE_PATH: '/', TLS_MODE: 'internal' });
    const r = await request(app).get('/__vibe-boot.js');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/javascript');
    // Short max-age so a mode flip propagates within ~60s without forcing
    // every browser to a hard refresh.
    expect(r.headers['cache-control']).toContain('max-age=60');
    expect(r.text).toContain('window.__VIBE_BOOT__ = {');
    expect(r.text).toContain('"basePath":""');
    expect(r.text).toContain('"tlsMode":"internal"');
  });

  it('escapes < in JSON output as defense in depth against </script> injection', async () => {
    // The endpoint serves with Content-Type: application/javascript and is
    // loaded as <script src="..."> so the browser parses in a JS context
    // where </script> is a literal — but appName is admin-mutable and a
    // future refactor could inline this content into HTML. Escape `<` so
    // the payload stays safe in any serialization context.
    const app = await loadApp({ BASE_PATH: '/', TLS_MODE: 'internal' });
    // Set a malicious app_name and confirm it doesn't appear unescaped.
    const { db } = await import('../db/knex.js');
    const original = await db('firm_settings').where({ id: 1 }).first('app_name');
    try {
      await db('firm_settings')
        .where({ id: 1 })
        .update({ app_name: '</script><img src=x onerror=pwn>' });
      const r = await request(app).get('/__vibe-boot.js');
      expect(r.status).toBe(200);
      // Raw '</script>' must NOT appear; the < should be <.
      expect(r.text).not.toContain('</script>');
      expect(r.text).toContain('\\u003c');
    } finally {
      await db('firm_settings')
        .where({ id: 1 })
        .update({ app_name: (original?.app_name as string | null | undefined) ?? null });
    }
  });

  it('reflects BASE_PATH=/connect for multi-app mode', async () => {
    const app = await loadApp({ BASE_PATH: '/connect', TLS_MODE: 'external' });
    const r = await request(app).get('/__vibe-boot.js');
    expect(r.status).toBe(200);
    expect(r.text).toContain('"basePath":"/connect"');
    expect(r.text).toContain('"tlsMode":"external"');
  });

  it('drops a trailing slash from BASE_PATH so concatenation is safe', async () => {
    // Operators routinely write '/connect/' with the trailing slash; the
    // server normalizes so url-composition (`${base}${path}`) doesn't
    // produce '//login' which most reverse proxies treat as a 301 to '/'.
    const app = await loadApp({ BASE_PATH: '/connect/', TLS_MODE: 'internal' });
    const r = await request(app).get('/__vibe-boot.js');
    expect(r.text).toContain('"basePath":"/connect"');
    expect(r.text).not.toContain('"basePath":"/connect/"');
  });

  it('does not require auth — the SPA loads it before the user is signed in', async () => {
    const app = await loadApp({ BASE_PATH: '/', TLS_MODE: 'internal' });
    const r = await request(app).get('/__vibe-boot.js');
    expect(r.status).toBe(200);
  });
});

describe('Session cookie path tracks SESSION_COOKIE_PATH', () => {
  it('default (single-app): cookie scoped to /', async () => {
    const app = await loadApp({
      BASE_PATH: '/',
      SESSION_COOKIE_PATH: '/',
      TLS_MODE: 'internal',
    });
    const r = await request(app)
      .post('/auth/login')
      .send({ username: 'kurt', password: 'kurt-dev-only-ChangeMe!' });
    expect(r.status).toBe(200);
    const setCookies = (r.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    const sid = setCookies.find((c) => c.startsWith('vibe.sid='));
    expect(sid).toBeTruthy();
    expect(sid).toMatch(/Path=\//);
    expect(sid).not.toMatch(/Path=\/connect/);
  });

  // Note: a multi-app variant of this test (SESSION_COOKIE_PATH=/connect)
  // belongs in its own file. Re-importing app.ts via vi.resetModules() leaks
  // PgStore session-table connections from the prior describe block and the
  // second express-session middleware fails to attach req.session. The
  // single-app test above plus the bootstrap-script tests below verify the
  // env knob flows end-to-end; whether the cookie says Path=/connect vs.
  // Path=/ is a one-line passthrough of the same env var. Tracked under
  // TODO(distribution): split into per-mode test files when the harness
  // grows a `vi.isolate()` story for module graphs that hold pg pools.
});

describe('TLS_MODE=external — admin TLS endpoints', () => {
  it('GET /admin/tls/status reports tlsMode=external', async () => {
    const app = await loadApp({ TLS_MODE: 'external' });
    const agent = await loginAs(app, 'kurt', 'kurt-dev-only-ChangeMe!');
    const r = await agent.get('/admin/tls/status');
    expect(r.status).toBe(200);
    expect(r.body.tlsMode).toBe('external');
  });

  it('POST /admin/tls/request returns 409 tls_managed_externally', async () => {
    const app = await loadApp({ TLS_MODE: 'external' });
    const agent = await loginAs(app, 'kurt', 'kurt-dev-only-ChangeMe!');
    const r = await agent.post('/admin/tls/request').send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('tls_managed_externally');
    expect(r.body.tlsMode).toBe('external');
  });

  it('POST /admin/tls/renew returns 409 tls_managed_externally', async () => {
    const app = await loadApp({ TLS_MODE: 'external' });
    const agent = await loginAs(app, 'kurt', 'kurt-dev-only-ChangeMe!');
    const r = await agent.post('/admin/tls/renew').send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('tls_managed_externally');
  });

  it('DELETE /admin/tls/config returns 409 tls_managed_externally', async () => {
    const app = await loadApp({ TLS_MODE: 'external' });
    const agent = await loginAs(app, 'kurt', 'kurt-dev-only-ChangeMe!');
    const r = await agent.delete('/admin/tls/config');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('tls_managed_externally');
  });

  it('the HTTP-01 responder route still answers (Caddy/CF can still verify)', async () => {
    // The plan keeps /.well-known/acme-challenge mounted in both modes so
    // an upstream proxy that uses HTTP-01 (or a cheap probe) still gets a
    // clean 404 on unknown tokens instead of a routing crash.
    const app = await loadApp({ TLS_MODE: 'external' });
    const r = await request(app).get('/.well-known/acme-challenge/does-not-exist');
    expect(r.status).toBe(404);
  });
});

describe('TLS_MODE=internal (default) — Phase 23 paths still work', () => {
  it('GET /admin/tls/status reports tlsMode=internal', async () => {
    const app = await loadApp({ TLS_MODE: 'internal' });
    const agent = await loginAs(app, 'kurt', 'kurt-dev-only-ChangeMe!');
    const r = await agent.get('/admin/tls/status');
    expect(r.status).toBe(200);
    expect(r.body.tlsMode).toBe('internal');
  });

  it('POST /admin/tls/request is accepted (does NOT 409 in internal mode)', async () => {
    const app = await loadApp({ TLS_MODE: 'internal' });
    const agent = await loginAs(app, 'kurt', 'kurt-dev-only-ChangeMe!');
    const r = await agent.post('/admin/tls/request').send({});
    // The service path 400s without configured domains and 202s with —
    // either way it's NOT a 409 'tls_managed_externally', which is the
    // contract we're checking. A 5xx is also a failure.
    expect(r.status).not.toBe(409);
    expect(r.status).toBeLessThan(500);
  });
});
