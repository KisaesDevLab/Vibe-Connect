/**
 * Integration tests for endpoints added alongside the install wizard / admin CRUD /
 * device enrollment / firm key metadata. Seeded test DB already has kurt/alice/bob/carol
 * users but NO firm_keys row; each test creates its own agent.
 */
import { beforeAll, describe, expect, it } from 'vitest';
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

type TestAgent = ReturnType<typeof request.agent>;
async function loginAs(username: string, password: string): Promise<TestAgent> {
  const agent = request.agent(app);
  const login = await agent.post('/auth/login').send({ username, password });
  if (login.status !== 200) {
    throw new Error(`loginAs(${username}) failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  return agent;
}

describe('install status', () => {
  it('GET /install/status returns installed=false / hasAdmin=true on seeded DB', async () => {
    const res = await request(app).get('/install/status');
    expect(res.status).toBe(200);
    expect(res.body.hasAdmin).toBe(true);
    // firm_keys was not part of the seed, so `installed` should be false.
    expect(res.body.installed).toBe(false);
  });

  it('POST /install/install succeeds on a clean firm_keys table and then refuses a second run', async () => {
    const { db } = await import('../db/knex.js');
    // Clean slate for the install row only (don't wipe users — breaks other tests).
    await db('firm_keys').del();

    const payload = {
      firmName: 'Test Firm LLP',
      adminUsername: 'installadmin',
      adminPassword: 'install-password-super-long-1234',
      adminDisplayName: 'Install Admin',
      adminEmail: 'install-admin@example.test',
    };
    const first = await request(app).post('/install/install').send(payload);
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.firmPublicKey).toEqual(expect.any(String));
    expect(Array.isArray(first.body.recoveryPhrase)).toBe(true);
    expect(first.body.recoveryPhrase).toHaveLength(24);
    for (const w of first.body.recoveryPhrase) expect(typeof w).toBe('string');
    expect(first.body.adminUserId).toEqual(expect.any(String));

    // Second attempt must refuse — idempotency is "fail with already_installed".
    const second = await request(app)
      .post('/install/install')
      .send({ ...payload, adminUsername: 'installadmin2' });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('already_installed');
  });
});

describe('user CRUD (admin-only)', () => {
  it('POST /users creates a user when caller is admin', async () => {
    const agent = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const created = await agent.post('/users').send({
      username: 'new-user-1',
      displayName: 'New User',
      email: 'nu1@example.test',
      password: 'new-user-password-1234!',
      isAdmin: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.user.username).toBe('new-user-1');
    expect(created.body.user.isAdmin).toBe(false);
    expect(created.body.user.isActive).toBe(true);
  });

  it('POST /users rejects non-admin callers with 403', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await agent
      .post('/users')
      .send({
        username: 'unauth-created',
        displayName: 'x',
        password: 'will-never-work-1234',
      });
    expect(res.status).toBe(403);
  });

  it('PATCH /users/:id + POST /users/:id/reset-password work for admin', async () => {
    const adminAgent = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const created = await adminAgent.post('/users').send({
      username: 'for-edit',
      displayName: 'Original Name',
      password: 'original-password-1234',
    });
    expect(created.status).toBe(201);
    const id = created.body.user.id;

    const patched = await adminAgent.patch(`/users/${id}`).send({
      displayName: 'Renamed User',
      isActive: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.user.displayName).toBe('Renamed User');
    expect(patched.body.user.isActive).toBe(false);

    const reset = await adminAgent.post(`/users/${id}/reset-password`).send({
      adminPassword: 'kurt-dev-only-ChangeMe!',
      newPassword: 'brand-new-password-1234!',
    });
    expect(reset.status).toBe(200);
    expect(reset.body.ok).toBe(true);
  });

  it('reset-password refuses when admin re-confirmation is wrong', async () => {
    const adminAgent = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const created = await adminAgent.post('/users').send({
      username: 'for-wrong-confirm',
      displayName: 'Target User',
      password: 'original-password-1234',
    });
    expect(created.status).toBe(201);
    const id = created.body.user.id;
    // Wrong admin password → 401, target's password unchanged.
    const reset = await adminAgent.post(`/users/${id}/reset-password`).send({
      adminPassword: 'not-the-right-password',
      newPassword: 'brand-new-password-1234!',
    });
    expect(reset.status).toBe(401);
    expect(reset.body.error).toBe('admin_password_mismatch');
  });
});

describe('device enrollment', () => {
  it('POST /users/me/devices stores a user-held device key record', async () => {
    const agent = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    const enroll = await agent.post('/users/me/devices').send({
      deviceId: 'test-device-bob-001',
      publicKey: 'deadbeef-pub-key-base64',
      encryptedPrivateKey: 'deadbeef-wrapped-key-base64',
      kdfSalt: 'c2FsdC1iYXNlNjQ=',
      kdfParams: { opsLimit: 3, memLimit: 65536, algorithm: 'argon2id13' },
      clientPlatform: 'pwa',
      clientVersion: '0.1.0',
    });
    expect(enroll.status).toBe(201);
    expect(enroll.body.keyVersion).toBe(1);

    // Re-enrolling the same deviceId rotates rather than duplicates.
    const rotate = await agent.post('/users/me/devices').send({
      deviceId: 'test-device-bob-001',
      publicKey: 'v2-pub-key',
      encryptedPrivateKey: 'v2-wrapped',
      kdfSalt: 'c2FsdC1uZXc=',
      kdfParams: { opsLimit: 3, memLimit: 65536, algorithm: 'argon2id13' },
      clientPlatform: 'pwa',
      clientVersion: '0.1.0',
    });
    expect(rotate.status).toBe(200);
    expect(rotate.body.keyVersion).toBe(2);

    const list = await agent.get('/users/me/devices');
    expect(list.status).toBe(200);
    const device = list.body.devices.find(
      (d: { deviceId: string }) => d.deviceId === 'test-device-bob-001',
    );
    expect(device).toBeTruthy();
    expect(device.keyVersion).toBe(2);
    expect(device.publicKey).toBe('v2-pub-key');
  });

  it('POST /users/me/devices requires auth', async () => {
    const res = await request(app).post('/users/me/devices').send({
      deviceId: 'x',
      publicKey: 'x',
      encryptedPrivateKey: 'x',
      kdfSalt: 'x',
      kdfParams: { opsLimit: 3, memLimit: 65536, algorithm: 'argon2id13' },
      clientPlatform: 'pwa',
      clientVersion: '0.1.0',
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /users/keys directory lookup', () => {
  it('returns active device public keys for the requested users', async () => {
    // Prime two devices across two users.
    const aliceAgent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    await aliceAgent.post('/users/me/devices').send({
      deviceId: 'alice-dev-a',
      publicKey: 'alice-pub-a',
      encryptedPrivateKey: 'x',
      kdfSalt: 'x',
      kdfParams: { opsLimit: 3, memLimit: 65536, algorithm: 'argon2id13' },
      clientPlatform: 'pwa',
      clientVersion: '0.1.0',
    });
    const carolAgent = await loginAs('carol', 'carol-dev-only-ChangeMe!');
    await carolAgent.post('/users/me/devices').send({
      deviceId: 'carol-dev-a',
      publicKey: 'carol-pub-a',
      encryptedPrivateKey: 'x',
      kdfSalt: 'x',
      kdfParams: { opsLimit: 3, memLimit: 65536, algorithm: 'argon2id13' },
      clientPlatform: 'pwa',
      clientVersion: '0.1.0',
    });

    const { db } = await import('../db/knex.js');
    const rows = await db('users').whereIn('username', ['alice', 'carol']).select('id', 'username');
    const byUsername = Object.fromEntries(rows.map((r) => [r.username, r.id]));
    const aliceId = byUsername.alice;
    const carolId = byUsername.carol;

    const res = await aliceAgent.get(`/users/keys?ids=${aliceId},${carolId}`);
    expect(res.status).toBe(200);
    const aliceKeys = res.body.keys[aliceId];
    const carolKeys = res.body.keys[carolId];
    expect(aliceKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deviceId: 'alice-dev-a', publicKey: 'alice-pub-a' }),
      ]),
    );
    expect(carolKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deviceId: 'carol-dev-a', publicKey: 'carol-pub-a' }),
      ]),
    );
  });

  it('rejects non-UUID ids silently and requires auth', async () => {
    const noAuth = await request(app).get('/users/keys?ids=not-a-uuid');
    expect(noAuth.status).toBe(401);

    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const garbage = await agent.get('/users/keys?ids=not-a-uuid,also-not');
    expect(garbage.status).toBe(200);
    expect(garbage.body.keys).toEqual({});
  });
});

describe('GET /firm/key-meta', () => {
  it('returns publicKey + rotationVersion + createdAt when installed', async () => {
    // firm_keys was installed earlier by the install test; if tests run in isolation
    // we install it here.
    const { db } = await import('../db/knex.js');
    const existing = await db('firm_keys').whereNull('retired_at').first();
    if (!existing) {
      await db('firm_keys').insert({
        public_key: 'fake-pub',
        encrypted_recovery_private_key: 'fake-wrap',
        kdf_params: JSON.stringify({ opsLimit: 3, memLimit: 65536, algorithm: 'argon2id13' }),
        kdf_salt: 'c2FsdA==',
        rotation_version: 1,
      });
    }
    const res = await request(app).get('/firm/key-meta');
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toEqual(expect.any(String));
    expect(res.body.rotationVersion).toBeGreaterThanOrEqual(1);
    expect(res.body.createdAt).toEqual(expect.any(String));
  });
});

describe('privileged actions terminate the target user\'s sessions', () => {
  it('reset-password kills the target\'s live session', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    // Create a fresh user so we can safely change their password without disturbing seeds.
    const created = await admin.post('/users').send({
      username: 'session-target',
      displayName: 'Session Target',
      password: 'original-password-1234',
    });
    expect(created.status).toBe(201);
    const targetId = created.body.user.id;

    // Log in as the target and confirm /auth/me works.
    const targetAgent = await loginAs('session-target', 'original-password-1234');
    const before = await targetAgent.get('/auth/me');
    expect(before.status).toBe(200);

    // Admin resets password.
    const reset = await admin
      .post(`/users/${targetId}/reset-password`)
      .send({ adminPassword: 'kurt-dev-only-ChangeMe!', newPassword: 'brand-new-password-1234!' });
    expect(reset.status).toBe(200);
    expect(reset.body.sessionsTerminated).toBeGreaterThanOrEqual(1);

    // The previously-logged-in target session must now 401.
    const after = await targetAgent.get('/auth/me');
    expect(after.status).toBe(401);
  });

  it('deactivation kills live sessions for the deactivated user', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const created = await admin.post('/users').send({
      username: 'deact-target',
      displayName: 'Deact Target',
      password: 'another-password-1234',
    });
    const targetId = created.body.user.id;
    const targetAgent = await loginAs('deact-target', 'another-password-1234');
    expect((await targetAgent.get('/auth/me')).status).toBe(200);

    const patch = await admin.patch(`/users/${targetId}`).send({ isActive: false });
    expect(patch.status).toBe(200);
    expect(patch.body.sessionsTerminated).toBeGreaterThanOrEqual(1);

    expect((await targetAgent.get('/auth/me')).status).toBe(401);
  });

  it('self-service change-password kills OTHER sessions but keeps the caller logged in', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    // Set up a user we can safely rotate.
    const created = await admin.post('/users').send({
      username: 'pw-rotate',
      displayName: 'PW Rotate',
      password: 'initial-rotate-password-1234',
    });
    expect(created.status).toBe(201);

    // Two agents logged in as the same user from "different browsers".
    const browserA = await loginAs('pw-rotate', 'initial-rotate-password-1234');
    const browserB = await loginAs('pw-rotate', 'initial-rotate-password-1234');
    expect((await browserA.get('/auth/me')).status).toBe(200);
    expect((await browserB.get('/auth/me')).status).toBe(200);

    // browserA changes password.
    const change = await browserA.post('/auth/change-password').send({
      currentPassword: 'initial-rotate-password-1234',
      newPassword: 'new-rotate-password-1234!',
    });
    expect(change.status).toBe(200);
    expect(change.body.otherSessionsTerminated).toBeGreaterThanOrEqual(1);

    // browserA stays logged in; browserB is now a ghost.
    expect((await browserA.get('/auth/me')).status).toBe(200);
    expect((await browserB.get('/auth/me')).status).toBe(401);
  });

  it('reactivation does NOT terminate sessions (there are none to kill, but also should not touch)', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const created = await admin.post('/users').send({
      username: 'react-target',
      displayName: 'React Target',
      password: 'some-password-1234',
    });
    const targetId = created.body.user.id;
    await admin.patch(`/users/${targetId}`).send({ isActive: false });
    const react = await admin.patch(`/users/${targetId}`).send({ isActive: true });
    expect(react.status).toBe(200);
    expect(react.body.sessionsTerminated).toBe(0);
  });
});

describe('idempotency keys on message send', () => {
  it('replaying the same X-Idempotency-Key returns the original message without duplicating', async () => {
    const { db } = await import('../db/knex.js');
    // Minimal conversation the caller is a member of.
    const adminAgent = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const me = await db('users').where({ username: 'kurt' }).first();
    const [convRow] = await db('conversations')
      .insert({ type: 'internal', display_name: 'idempotency test' })
      .returning(['id']);
    const convId = (convRow as { id: string }).id;
    await db('conversation_members').insert({ conversation_id: convId, user_id: me!.id });

    const payload = {
      ciphertext: Buffer.from('dummy').toString('base64'),
      contentKeyVersion: 1,
    };
    const key = 'idem-test-aaaa-bbbb-cccc-dddd-eeee-ffff';
    const first = await adminAgent
      .post(`/conversations/${convId}/messages`)
      .set('X-Idempotency-Key', key)
      .send(payload);
    expect(first.status).toBe(201);
    const firstId = first.body.id;

    // Replay with the same key → 200 with Idempotent-Replay header and same id.
    const replay = await adminAgent
      .post(`/conversations/${convId}/messages`)
      .set('X-Idempotency-Key', key)
      .send(payload);
    expect(replay.status).toBe(200);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(firstId);

    const count = await db('messages')
      .where({ conversation_id: convId, sender_id: me!.id })
      .count<{ count: string }[]>('* as count');
    expect(Number(count[0]!.count)).toBe(1);

    // A different key creates a new row.
    const third = await adminAgent
      .post(`/conversations/${convId}/messages`)
      .set('X-Idempotency-Key', 'idem-test-DIFFERENT-key-value-000000')
      .send(payload);
    expect(third.status).toBe(201);
    expect(third.body.id).not.toBe(firstId);
  });

  it('malformed idempotency key is ignored, not an error', async () => {
    const { db } = await import('../db/knex.js');
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const me = await db('users').where({ username: 'kurt' }).first();
    const [convRow] = await db('conversations')
      .insert({ type: 'internal', display_name: 'idempotency malformed' })
      .returning(['id']);
    const convId = (convRow as { id: string }).id;
    await db('conversation_members').insert({ conversation_id: convId, user_id: me!.id });

    const res = await admin
      .post(`/conversations/${convId}/messages`)
      .set('X-Idempotency-Key', 'has spaces / not allowed')
      .send({ ciphertext: Buffer.from('x').toString('base64'), contentKeyVersion: 1 });
    expect(res.status).toBe(201);
  });
});

describe('POST /admin/users/bulk', () => {
  it('creates many users in one call, skipping duplicates', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const payload = {
      users: [
        {
          username: 'bulk-alpha',
          displayName: 'Bulk Alpha',
          initialPassword: 'bulk-alpha-initial-1234',
          isAdmin: false,
        },
        {
          username: 'bulk-beta',
          displayName: 'Bulk Beta',
          email: 'beta@firm.test',
          initialPassword: 'bulk-beta-initial-1234',
          isAdmin: true,
        },
        // duplicate of an existing seeded user
        {
          username: 'kurt',
          displayName: 'duplicate kurt',
          initialPassword: 'does-not-matter-1234',
        },
      ],
    };
    const res = await admin.post('/admin/users/bulk').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(2);
    expect(res.body.skipped).toEqual([{ username: 'kurt', reason: 'already_exists' }]);

    // The two new users should now appear in /users.
    const list = await admin.get('/users');
    const usernames = list.body.users.map((u: { username: string }) => u.username);
    expect(usernames).toEqual(expect.arrayContaining(['bulk-alpha', 'bulk-beta']));
    // The admin flag came through.
    const beta = list.body.users.find((u: { username: string }) => u.username === 'bulk-beta');
    expect(beta.isAdmin).toBe(true);
  });

  it('requires admin', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await alice
      .post('/admin/users/bulk')
      .send({ users: [{ username: 'x', displayName: 'x', initialPassword: 'x'.repeat(12) }] });
    expect(res.status).toBe(403);
  });
});

describe('audit row carries reqId via AsyncLocalStorage', () => {
  it('deactivation audit row contains the request id from requestLog', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const created = await admin.post('/users').send({
      username: 'reqid-target',
      displayName: 'ReqId Target',
      password: 'some-password-1234',
    });
    expect(created.status).toBe(201);
    const id = created.body.user.id;
    const incomingReqId = 'test-trace-audit';
    // Client-supplied X-Request-Ids are now tagged `ext:` on the server side
    // so log readers can distinguish attacker-chosen from server-minted IDs.
    // See requestLog.ts. Audit row stores the tagged form.
    const storedReqId = `ext:${incomingReqId}`;
    const res = await admin
      .patch(`/users/${id}`)
      .set('X-Request-Id', incomingReqId)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    const { db } = await import('../db/knex.js');
    const row = await db('audit_log')
      .where({ action: 'admin.user_updated', target_id: id })
      .orderBy('created_at', 'desc')
      .first();
    expect(row).toBeTruthy();
    expect((row!.details as { reqId?: string }).reqId).toBe(storedReqId);

    // Filter endpoint finds it by the tagged form.
    const list = await admin.get(`/admin/audit?reqId=${encodeURIComponent(storedReqId)}`);
    expect(list.status).toBe(200);
    expect(list.body.rows.length).toBeGreaterThanOrEqual(1);
    expect(list.body.rows[0].action).toBe('admin.user_updated');
  });
});

describe('retention sweep', () => {
  it('shreds messages older than retention_days when run via /admin/retention/run', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const { db } = await import('../db/knex.js');

    // Configure retention to 30 days.
    const setSettings = await admin.patch('/admin/settings').send({ retentionDays: 30 });
    expect(setSettings.status).toBe(200);

    // Fabricate an old message row. We bypass the HTTP layer because it requires a
    // conversation membership and a valid wrapped-key setup; retention doesn't care
    // about who wrote the ciphertext, only about created_at and ciphertext bytes.
    const conv = await db('conversations')
      .insert({ type: 'internal', display_name: 'Retention test' })
      .returning(['id']);
    const convId = (conv[0] as { id: string }).id;
    const sender = await db('users').where({ username: 'kurt' }).first();
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const [old] = await db('messages')
      .insert({
        conversation_id: convId,
        sender_id: sender!.id,
        ciphertext: Buffer.from('dummy-ciphertext-that-should-be-shredded'),
        content_key_version: 1,
        created_at: sixtyDaysAgo,
        source: 'app',
      })
      .returning(['id']);
    const oldId = (old as { id: string }).id;

    const res = await admin.post('/admin/retention/run').send({});
    expect(res.status).toBe(200);
    expect(res.body.messagesShredded).toBeGreaterThanOrEqual(1);

    const row = await db('messages').where({ id: oldId }).first();
    expect(Buffer.byteLength(row.ciphertext as Buffer)).toBe(0);
  });

  it('is a no-op when retention_days is null', async () => {
    const admin = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    await admin.patch('/admin/settings').send({ retentionDays: null });
    const res = await admin.post('/admin/retention/run').send({});
    expect(res.status).toBe(200);
    expect(res.body.messagesShredded).toBe(0);
    expect(res.body.retentionDays).toBeNull();
  });

  it('requires admin', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await alice.post('/admin/retention/run').send({});
    expect(res.status).toBe(403);
  });
});

describe('GET /auth/oidc/config', () => {
  it('reports disabled when no OIDC env vars set', async () => {
    delete process.env.OIDC_ISSUER_URL;
    const res = await request(app).get('/auth/oidc/config');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.loginUrl).toBeNull();
  });
});

describe('PATCH /conversations/:id/wrapped-keys — multi-device rewrap', () => {
  // Simulates the "log in on a second browser" case: Alice has device 1, creates
  // a conversation with Kurt. Alice then adds device 2; Kurt's existing device
  // detects the new device and PATCHes an additional sealed key entry.
  it('additively merges new entries and ignores attempted overwrites', async () => {
    const crypto = await import('@vibe-connect/crypto');
    await crypto.ready();

    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const kurtMe = await kurt.get('/auth/me');
    const aliceMe = await alice.get('/auth/me');
    const kurtUserId: string = kurtMe.body.user.id;
    const aliceUserId: string = aliceMe.body.user.id;

    // Kurt has 1 device, Alice starts with 1 device. Both enroll.
    const kurtKp1 = await crypto.generateKeypair();
    const aliceKp1 = await crypto.generateKeypair();
    const kurtRid1 = `${kurtUserId}:kurt-dev-1`;
    const aliceRid1 = `${aliceUserId}:alice-dev-1`;

    // Conversation keyed to both.
    const { bundle, wrappedKeys } = await crypto.createConversationKey([
      { id: kurtRid1, publicKey: kurtKp1.publicKey },
      { id: aliceRid1, publicKey: aliceKp1.publicKey },
    ]);
    const created = await kurt.post('/conversations').send({
      type: 'internal',
      memberUserIds: [kurtUserId, aliceUserId],
      wrappedKeys,
      rotationVersion: bundle.rotationVersion,
    });
    expect(created.status).toBe(201);
    const convId: string = created.body.id;

    // Alice enrolls a second device. Kurt's browser notices and seals a copy
    // of the conversation key to Alice's new public key. It uses a fresh keypair
    // to prove the additive merge lets Alice's *new* device decrypt.
    const aliceKp2 = await crypto.generateKeypair();
    const aliceRid2 = `${aliceUserId}:alice-dev-2`;
    const rewrapped = await crypto.wrapKey(bundle.key, aliceKp2.publicKey);
    const patch = await kurt.patch(`/conversations/${convId}/wrapped-keys`).send({
      added: { [aliceRid2]: rewrapped },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.added).toEqual([aliceRid2]);

    // Alice's new device fetches the conversation — its key is present and
    // actually unwraps to the original conversation key.
    const detail = await alice.get(`/conversations/${convId}`);
    expect(detail.status).toBe(200);
    const wk = detail.body.wrappedKeys as Record<string, string>;
    expect(wk[aliceRid1]).toBeTruthy();
    expect(wk[aliceRid2]).toBeTruthy();
    const unwrapped = await crypto.unwrapKey(wk[aliceRid2]!, aliceKp2.publicKey, aliceKp2.secretKey);
    expect(Buffer.from(unwrapped)).toEqual(Buffer.from(bundle.key));

    // A racing / malicious attempt to OVERWRITE Alice's existing entry must be
    // silently dropped — the original sealed key stays put so Alice's first
    // device keeps working.
    const garbage = await crypto.wrapKey(bundle.key, kurtKp1.publicKey); // wrong key for rid
    const racing = await kurt.patch(`/conversations/${convId}/wrapped-keys`).send({
      added: { [aliceRid1]: garbage, [`${aliceUserId}:alice-dev-3`]: garbage },
    });
    expect(racing.status).toBe(200);
    // Only the brand-new entry was accepted.
    expect(racing.body.added).toEqual([`${aliceUserId}:alice-dev-3`]);
    const refetch = await alice.get(`/conversations/${convId}`);
    const wk2 = refetch.body.wrappedKeys as Record<string, string>;
    expect(wk2[aliceRid1]).toBe(wk[aliceRid1]); // unchanged
  });

  it('rejects malformed recipient ids', async () => {
    const crypto = await import('@vibe-connect/crypto');
    await crypto.ready();

    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const kurtMe = await kurt.get('/auth/me');
    const aliceMe = await alice.get('/auth/me');

    const kurtKp = await crypto.generateKeypair();
    const aliceKp = await crypto.generateKeypair();
    const { bundle, wrappedKeys } = await crypto.createConversationKey([
      { id: `${kurtMe.body.user.id}:kurt-dev-1`, publicKey: kurtKp.publicKey },
      { id: `${aliceMe.body.user.id}:alice-dev-1`, publicKey: aliceKp.publicKey },
    ]);
    const created = await kurt.post('/conversations').send({
      type: 'internal',
      memberUserIds: [kurtMe.body.user.id, aliceMe.body.user.id],
      wrappedKeys,
      rotationVersion: bundle.rotationVersion,
    });
    const convId: string = created.body.id;

    const garbage = await crypto.wrapKey(bundle.key, kurtKp.publicKey);
    const bad = await kurt.patch(`/conversations/${convId}/wrapped-keys`).send({
      added: { 'not-a-valid-recipient': garbage },
    });
    expect(bad.status).toBe(400);
  });

  it('rejects non-members', async () => {
    const bob = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    // Use a bogus conversation id — bob isn't a member of ANY conversation.
    const bad = await bob.patch(
      '/conversations/00000000-0000-0000-0000-000000000000/wrapped-keys',
    ).send({ added: { '00000000-0000-0000-0000-000000000000:dev-1': 'ignored' } });
    // assertCallerIsMember throws, which surfaces as 403 or 404 depending on order.
    expect([403, 404]).toContain(bad.status);
  });
});
