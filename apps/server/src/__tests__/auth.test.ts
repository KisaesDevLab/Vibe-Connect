/**
 * Phase 2 — Auth & user/group route tests.
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
  // Import app AFTER env is set, so knex singleton binds to test DB.
  const mod = await import('../app.js');
  app = mod.createApp();
});

// Note: we intentionally DO NOT destroy the shared knex pool in afterAll. Several test files
// share the same singleton; racing destroys trigger unhandled "aborted" rejections from
// pending pool operations. Node exits at the end of the vitest run and reclaims it.

beforeEach(async () => {
  // Each test starts clean so rate-limit windows don't accumulate.
  // We don't reset the full DB per test — too slow. Instead, rely on idempotent test cases.
});

describe('auth', () => {
  it('rejects login with unknown user', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'nobody', password: 'wrong-password-12345' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('rejects login with wrong password', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'kurt', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('accepts valid login and returns user', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'kurt', password: 'kurt-dev-only-ChangeMe!' });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('kurt');
    expect(res.body.user.isAdmin).toBe(true);
    const cookie = res.headers['set-cookie'];
    expect(cookie, 'session cookie should be set').toBeTruthy();
  });

  it('/auth/me requires auth', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('/auth/me returns user when authenticated', async () => {
    const agent = request.agent(app);
    const login = await agent
      .post('/auth/login')
      .send({ username: 'alice', password: 'alice-dev-only-ChangeMe!' });
    expect(login.status).toBe(200);
    const me = await agent.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('alice');
  });

  it('logout clears the session', async () => {
    const agent = request.agent(app);
    await agent
      .post('/auth/login')
      .send({ username: 'alice', password: 'alice-dev-only-ChangeMe!' });
    const out = await agent.post('/auth/logout');
    expect(out.status).toBe(200);
    const me = await agent.get('/auth/me');
    expect(me.status).toBe(401);
  });

  it('change-password requires the current password', async () => {
    const agent = request.agent(app);
    await agent
      .post('/auth/login')
      .send({ username: 'carol', password: 'carol-dev-only-ChangeMe!' });
    const bad = await agent.post('/auth/change-password').send({
      currentPassword: 'wrong',
      newPassword: 'new-password-longer-than-12-chars',
    });
    expect(bad.status).toBe(400);

    const good = await agent.post('/auth/change-password').send({
      currentPassword: 'carol-dev-only-ChangeMe!',
      newPassword: 'new-password-longer-than-12-chars',
    });
    expect(good.status).toBe(200);

    // Can log in with the new password:
    const reLogin = await request(app).post('/auth/login').send({
      username: 'carol',
      password: 'new-password-longer-than-12-chars',
    });
    expect(reLogin.status).toBe(200);
  });
});

describe('permissions — users routes', () => {
  it('GET /users requires auth', async () => {
    const r = await request(app).get('/users');
    expect(r.status).toBe(401);
  });

  it('non-admin cannot create users', async () => {
    const agent = request.agent(app);
    await agent
      .post('/auth/login')
      .send({ username: 'alice', password: 'alice-dev-only-ChangeMe!' });
    const r = await agent.post('/users').send({
      username: 'someone',
      password: 'another-long-enough-password',
      displayName: 'Nope',
    });
    expect(r.status).toBe(403);
  });

  it('admin can create and fetch a user', async () => {
    const agent = request.agent(app);
    await agent.post('/auth/login').send({ username: 'kurt', password: 'kurt-dev-only-ChangeMe!' });
    const created = await agent.post('/users').send({
      username: 'dave',
      email: 'dave@vibeconnect.local',
      password: 'dave-dev-only-ChangeMe!',
      displayName: 'Dave',
    });
    expect(created.status).toBe(201);
    expect(created.body.user.username).toBe('dave');
    const list = await agent.get('/users');
    expect(list.status).toBe(200);
    expect(list.body.users.some((u: { username: string }) => u.username === 'dave')).toBe(true);
  });
});

describe('permissions — groups routes', () => {
  it('GET /groups requires auth', async () => {
    const r = await request(app).get('/groups');
    expect(r.status).toBe(401);
  });

  it('any authenticated user can list groups', async () => {
    const agent = request.agent(app);
    await agent
      .post('/auth/login')
      .send({ username: 'alice', password: 'alice-dev-only-ChangeMe!' });
    const r = await agent.get('/groups');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.groups)).toBe(true);
  });

  it('non-admin cannot create a group', async () => {
    const agent = request.agent(app);
    await agent
      .post('/auth/login')
      .send({ username: 'alice', password: 'alice-dev-only-ChangeMe!' });
    const r = await agent.post('/groups').send({ name: 'Hacked', sortOrder: 1 });
    expect(r.status).toBe(403);
  });

  it('admin can CRUD a group', async () => {
    const agent = request.agent(app);
    await agent.post('/auth/login').send({ username: 'kurt', password: 'kurt-dev-only-ChangeMe!' });
    const created = await agent.post('/groups').send({ name: 'Ops', sortOrder: 50 });
    expect(created.status).toBe(201);
    const gid = created.body.group.id as string;
    const renamed = await agent.patch(`/groups/${gid}`).send({ name: 'Operations' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.group.name).toBe('Operations');
    const removed = await agent.delete(`/groups/${gid}`);
    expect(removed.status).toBe(200);
  });
});
