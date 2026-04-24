/**
 * TLS / Let's Encrypt admin endpoints. Covers:
 *   - GET  /admin/tls/status returns metadata with no private-key material
 *   - POST /admin/tls/request kicks off a background order that exercises
 *     the HTTP-01 responder end-to-end (via a mocked acme-client)
 *   - settingsSchema writes accept TLS fields + reject bad domains
 *   - non-admin staff forbidden
 *
 * acme-client is mocked at the module top (vi.mock is hoisted) so the
 * same Express app and the same tlsAcme singleton are used throughout —
 * avoiding the double-import trap where a fresh module has its own
 * http01Tokens map invisible to the app's responder.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { resetTestDb } from './test-helpers.js';

// Shared between the mock and the tests. Reset per test.
const orderState: { tokensSeen: string[]; keyAuthByToken: Map<string, string> } = {
  tokensSeen: [],
  keyAuthByToken: new Map(),
};

// Real self-signed cert generated offline via
//   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
//     -days 3650 -nodes -subj /CN=test.local \
//     -addext 'subjectAltName=DNS:test.local,DNS:portal.test.local'
// Valid through April 2036. node:crypto.X509Certificate parses it cleanly,
// which is what the tlsAcme service relies on for subject/issuer/expiry
// metadata extraction.
const FAKE_CERT_PEM =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIIBqTCCAU+gAwIBAgIUX4Ld99YeVBrYzm1Xn4ZPI/3I0tMwCgYIKoZIzj0EAwIw\n' +
  'FTETMBEGA1UEAwwKdGVzdC5sb2NhbDAeFw0yNjA0MjQwMTQwMzhaFw0zNjA0MjEw\n' +
  'MTQwMzhaMBUxEzARBgNVBAMMCnRlc3QubG9jYWwwWTATBgcqhkjOPQIBBggqhkjO\n' +
  'PQMBBwNCAATLpMgCwv2Hi13K0Vm6Oo6i3b9qRsosu8JnW/bkiwNNEjMen7buYnL2\n' +
  'ppEB4jyizvl4si5QScU3FxbPVksFNK0bo30wezAdBgNVHQ4EFgQUK0gUXVvsPN1t\n' +
  'dLYGLD/997lmV+8wHwYDVR0jBBgwFoAUK0gUXVvsPN1tdLYGLD/997lmV+8wDwYD\n' +
  'VR0TAQH/BAUwAwEB/zAoBgNVHREEITAfggp0ZXN0LmxvY2FsghFwb3J0YWwudGVz\n' +
  'dC5sb2NhbDAKBggqhkjOPQQDAgNIADBFAiBYoZ6H9sspmDKKHjjHEJdT8Ij61AKE\n' +
  'SkD+zb0JBUhvWQIhAP96AJJfpH7XrGcCOqUlxKLtpuWrMIlSSNrDH8W4q8m/\n' +
  '-----END CERTIFICATE-----\n';

const FAKE_PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\n' +
  'MC4CAQAwBQYDK2VwBCIEIFakePrivateKeyBytesUsedOnlyInTestsAAAAAAAAAA\n' +
  '-----END PRIVATE KEY-----\n';

vi.mock('acme-client', () => {
  class FakeClient {
    constructor(_opts: unknown) {}
    async auto(opts: {
      challengeCreateFn: (
        authz: unknown,
        challenge: unknown,
        keyAuthorization: string,
      ) => Promise<unknown>;
      challengeRemoveFn: (
        authz: unknown,
        challenge: unknown,
        keyAuthorization: string,
      ) => Promise<unknown>;
    }): Promise<string> {
      const token = 'test-token-' + Math.random().toString(36).slice(2, 10);
      const keyAuth = `${token}.synthetic-key-thumbprint`;
      orderState.tokensSeen.push(token);
      orderState.keyAuthByToken.set(token, keyAuth);
      const authz = { identifier: { value: 'connect.example.test' } };
      const challenge = { type: 'http-01', token };
      await opts.challengeCreateFn(authz, challenge, keyAuth);
      // Give the test a deterministic pause to probe the responder.
      await new Promise((r) => setTimeout(r, 5));
      await opts.challengeRemoveFn(authz, challenge, keyAuth);
      return FAKE_CERT_PEM;
    }
    async revokeCertificate(): Promise<void> {
      /* noop */
    }
  }
  const mod = {
    Client: FakeClient,
    crypto: {
      createPrivateKey: async () => Buffer.from(FAKE_PRIVATE_KEY_PEM),
      createCsr: async () => [Buffer.from(FAKE_PRIVATE_KEY_PEM), Buffer.from('fake-csr')],
    },
  };
  // acme-client supports both `import acme from` and `import * as acme from`
  // in the wild; expose the same shape under `default` so either works.
  return { ...mod, default: mod };
});

let app: Express;
let testTlsDir: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  testTlsDir = path.join(process.cwd(), '.test-tls-' + Date.now());
  process.env.TLS_OUTPUT_DIR = testTlsDir;
  await fs.mkdir(testTlsDir, { recursive: true });
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
  orderState.tokensSeen = [];
  orderState.keyAuthByToken.clear();
  const { db } = await import('../db/knex.js');
  await db('firm_settings').where({ id: 1 }).update({
    tls_staff_domain: null,
    tls_portal_domain: null,
    tls_acme_email: null,
    tls_acme_environment: 'staging',
    tls_challenge_type: 'http-01',
    tls_acme_account_key_sealed: null,
    tls_cert_subject: null,
    tls_cert_issuer: null,
    tls_cert_expires_at: null,
    tls_cert_requested_at: null,
    tls_last_error: null,
  });
  for (const f of await fs.readdir(testTlsDir).catch(() => [])) {
    await fs.rm(path.join(testTlsDir, f), { force: true });
  }
});

describe('GET /admin/tls/status', () => {
  it('returns config + null cert when nothing configured', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const res = await admin.get('/admin/tls/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          staffDomain: null,
          portalDomain: null,
          acmeEmail: null,
          acmeEnvironment: 'staging',
          challengeType: 'http-01',
          accountKeyConfigured: false,
        }),
        cert: null,
        inFlight: false,
      }),
    );
    // Critical: response MUST NOT contain private-key material.
    const asJson = JSON.stringify(res.body);
    expect(asJson).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(asJson).not.toContain('BEGIN EC PRIVATE KEY');
    expect(asJson).not.toContain('BEGIN PRIVATE KEY');
  });

  it('requires admin — non-admin staff gets 403', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r1 = await alice.get('/admin/tls/status');
    const r2 = await alice.post('/admin/tls/request').send({});
    const r3 = await alice.delete('/admin/tls/config');
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
    expect(r3.status).toBe(403);
  });
});

describe('PATCH /admin/settings stores TLS fields', () => {
  it('persists the four TLS settings and validates domain shape', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const good = await admin.patch('/admin/settings').send({
      tlsStaffDomain: 'connect.example.com',
      tlsPortalDomain: 'portal.example.com',
      tlsAcmeEmail: 'ops@example.com',
      tlsAcmeEnvironment: 'production',
    });
    expect(good.status).toBe(200);
    const readback = await admin.get('/admin/tls/status');
    expect(readback.body.config).toEqual(
      expect.objectContaining({
        staffDomain: 'connect.example.com',
        portalDomain: 'portal.example.com',
        acmeEmail: 'ops@example.com',
        acmeEnvironment: 'production',
      }),
    );

    const bad = await admin
      .patch('/admin/settings')
      .send({ tlsStaffDomain: 'not a domain' });
    expect(bad.status).toBe(400);
  });
});

describe('HTTP-01 responder + background order', () => {
  it('runAcmeOrder registers token, responder serves it, token cleared after', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    await admin.patch('/admin/settings').send({
      tlsStaffDomain: 'connect.example.test',
      tlsAcmeEmail: 'ops@example.test',
      tlsAcmeEnvironment: 'staging',
    });

    // Instrument the mock's challengeCreateFn path so the test can probe
    // the responder mid-flight. We wrap the order in a racing probe: once
    // orderState.tokensSeen has a token, hit the responder and record
    // what it returned.
    const { runAcmeOrder, getHttp01KeyAuthorization } = await import(
      '../services/tlsAcme.js'
    );

    // Kick the order + race it with a probe against the responder. The
    // FakeClient sleeps 5ms between provision and cleanup to give us a
    // deterministic window.
    const orderPromise = runAcmeOrder({ actorUserId: null });
    // Poll until a token shows up, then probe.
    let probeStatus = 0;
    let probeBody = '';
    for (let i = 0; i < 50; i++) {
      if (orderState.tokensSeen.length > 0) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    const [token] = orderState.tokensSeen;
    expect(token).toBeTruthy();
    // Responder sees the registered token.
    const probe = await request(app).get(`/.well-known/acme-challenge/${token}`);
    probeStatus = probe.status;
    probeBody = probe.text;
    // Also verify the service-level accessor resolves the same key-auth.
    expect(getHttp01KeyAuthorization(token!)).toBe(probeBody);

    await orderPromise;

    expect(probeStatus).toBe(200);
    expect(probeBody).toBe(orderState.keyAuthByToken.get(token!));

    // Token is cleaned up after cleanup() runs.
    const afterCleanup = await request(app).get(
      `/.well-known/acme-challenge/${token}`,
    );
    expect(afterCleanup.status).toBe(404);

    // Cert files landed on disk.
    const connectCrt = await fs.readFile(path.join(testTlsDir, 'connect.crt'), 'utf8');
    expect(connectCrt).toContain('BEGIN CERTIFICATE');
    const portalCrt = await fs.readFile(path.join(testTlsDir, 'portal.crt'), 'utf8');
    expect(portalCrt).toBe(connectCrt);
    // Private key is restrictive-mode on POSIX. Windows ignores chmod on
    // most file systems, so the assertion is platform-gated — the
    // production image runs on Linux where fs.writeFile's mode honors 0600.
    if (process.platform !== 'win32') {
      const connectKeyStat = await fs.stat(path.join(testTlsDir, 'connect.key'));
      expect(connectKeyStat.mode & 0o777).toBe(0o600);
    }
  });

  it('unknown token returns 404 cleanly with no auth required', async () => {
    const res = await request(app).get(
      '/.well-known/acme-challenge/does-not-exist-anywhere',
    );
    expect(res.status).toBe(404);
    expect(res.text).toBe('not found');
  });
});

describe('renewIfExpiring', () => {
  it('is a no-op when no cert on disk', async () => {
    const { renewIfExpiring } = await import('../services/tlsAcme.js');
    const r = await renewIfExpiring({ actorUserId: null });
    expect(r.renewed).toBe(false);
    expect(r.reason).toBe('no_cert');
  });
});

afterAll(async () => {
  const { db } = await import('../db/knex.js');
  await db.destroy();
  await fs.rm(testTlsDir, { recursive: true, force: true }).catch(() => {});
});
