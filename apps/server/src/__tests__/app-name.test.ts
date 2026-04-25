/**
 * Integration tests for the admin-settable app display name override:
 *   - PATCH /admin/settings { appName } persists to firm_settings.app_name
 *   - GET  /firm/security-policy surfaces appName to any authenticated staff
 *   - Empty/whitespace clears the override (returns null)
 *   - Non-admin staff cannot change it but can read it
 *
 * Seeded users (apps/server/src/db/seeds/01_groups_and_users.js):
 *   alice  / alice-dev-only-ChangeMe!  (non-admin)
 *   kurt   / kurt-dev-only-ChangeMe!   (admin)
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
}, 120_000);

afterAll(async () => {
  // Match harness pattern: leave the pool alone between files.
});

type TestAgent = ReturnType<typeof request.agent>;
async function loginAs(username: string, password: string): Promise<TestAgent> {
  const agent = request.agent(app);
  const r = await agent.post('/auth/login').send({ username, password });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return agent;
}

beforeEach(async () => {
  // Ensure a clean slate for app_name between tests so leftover state from
  // earlier cases can't mask a regression.
  const { db } = await import('../db/knex.js');
  await db('firm_settings').where({ id: 1 }).update({ app_name: null });
});

describe('app display name override', () => {
  it('GET /firm/security-policy returns appName=null by default', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.get('/firm/security-policy');
    expect(r.status).toBe(200);
    expect(r.body.appName).toBeNull();
  });

  it('admin can PATCH appName and it surfaces on the policy endpoint to any staff', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const set = await kurt.patch('/admin/settings').send({ appName: 'Acme Secure Mail' });
    expect(set.status).toBe(200);
    const policy = await alice.get('/firm/security-policy');
    expect(policy.status).toBe(200);
    expect(policy.body.appName).toBe('Acme Secure Mail');
  });

  it('strips surrounding whitespace before persisting', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    await kurt.patch('/admin/settings').send({ appName: '   Acme   ' });
    const policy = await kurt.get('/firm/security-policy');
    expect(policy.body.appName).toBe('Acme');
  });

  it('treats empty string as "clear"; policy returns null', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    await kurt.patch('/admin/settings').send({ appName: 'Acme' });
    const cleared = await kurt.patch('/admin/settings').send({ appName: '' });
    expect(cleared.status).toBe(200);
    const policy = await kurt.get('/firm/security-policy');
    expect(policy.body.appName).toBeNull();
  });

  it('treats null as "clear"; policy returns null', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    await kurt.patch('/admin/settings').send({ appName: 'Acme' });
    const cleared = await kurt.patch('/admin/settings').send({ appName: null });
    expect(cleared.status).toBe(200);
    const policy = await kurt.get('/firm/security-policy');
    expect(policy.body.appName).toBeNull();
  });

  it('rejects non-admin PATCH', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.patch('/admin/settings').send({ appName: 'NopeCo' });
    expect(r.status).toBe(403);
  });

  it('rejects names longer than 80 chars', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const long = 'A'.repeat(81);
    const r = await kurt.patch('/admin/settings').send({ appName: long });
    expect(r.status).toBe(400);
  });
});
