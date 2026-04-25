/**
 * Phase 24.2 — Integration tests for the request-lists/items routes plus
 * the message post-insert hook that auto-flips item status.
 *
 * Hits the live test DB via supertest. Covers the route layer:
 *   - membership authorization (403 for non-members)
 *   - end-to-end happy path: create list → post message with linkage →
 *     server flips status='submitted' → mark-done → list completes
 *   - portal-side message linkage works the same way
 *   - revision request posts a system message into the thread
 *   - retro-link via /request-items/:id/link-message patches the message's
 *     ciphertext_meta so subsequent fetches see the linkage
 *
 * Seeded users: alice (non-admin), bob (non-admin), kurt (admin).
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
  // Pool stays open per harness convention.
});

interface SeedUserIds {
  kurt: string;
  alice: string;
  bob: string;
}
let userIds: SeedUserIds;
let conversationId: string;

beforeEach(async () => {
  const { db } = await import('../db/knex.js');
  await db('request_items').del();
  await db('request_lists').del();
  await db('request_templates').del();
  await db('audit_log').del();
  await db('attachments').del();
  await db('messages').del();
  await db('conversation_members').del();
  await db('conversation_keys').del();
  await db('conversations').del();
  // Re-fetch user IDs since resetTestDb only ran once.
  const rows = await db('users')
    .whereIn('username', ['kurt', 'alice', 'bob'])
    .select('id', 'username');
  userIds = Object.fromEntries(rows.map((r) => [r.username, r.id])) as SeedUserIds;
  // Alice + Bob in conversation; Kurt is non-member.
  const [conv] = await db('conversations').insert({ type: 'internal' }).returning(['id']);
  conversationId = conv.id;
  await db('conversation_members').insert([
    { conversation_id: conversationId, user_id: userIds.alice },
    { conversation_id: conversationId, user_id: userIds.bob },
  ]);
  // Phase 24 follow-up: contentKeyVersion validation requires a row in
  // conversation_keys. Seed v1 with empty wrappedKeys (tests don't actually
  // unwrap; they just need the existence proof).
  await db('conversation_keys').insert({
    conversation_id: conversationId,
    rotation_version: 1,
    wrapped_keys: JSON.stringify({}),
  });
});

type TestAgent = ReturnType<typeof request.agent>;
async function loginAs(username: string, password: string): Promise<TestAgent> {
  const agent = request.agent(app);
  const r = await agent.post('/auth/login').send({ username, password });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return agent;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

describe('POST /conversations/:id/request-lists', () => {
  it('member creates a list with seeded items (201)', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.post(`/conversations/${conversationId}/request-lists`).send({
      title: '2024 Tax Documents',
      description: 'Year-end intake',
      dueDate: '2026-04-30',
      items: [
        { titleCiphertext: b64('w-2'), contentKeyVersion: 1, responseType: 'file' },
        { titleCiphertext: b64('1099'), contentKeyVersion: 1, responseType: 'both' },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.list.title).toBe('2024 Tax Documents');
    expect(r.body.list.items).toHaveLength(2);
    expect(r.body.list.items[0].titleCiphertext).toBe(b64('w-2'));
  });

  it('non-member is rejected with 403', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt.post(`/conversations/${conversationId}/request-lists`).send({
      title: 'should fail',
    });
    expect(r.status).toBe(403);
  });
});

describe('GET /conversations/:id/request-lists', () => {
  it('lists for a member; refuses non-member', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    await alice.post(`/conversations/${conversationId}/request-lists`).send({
      title: 'L1',
    });
    const aliceList = await alice.get(`/conversations/${conversationId}/request-lists`);
    expect(aliceList.status).toBe(200);
    expect(aliceList.body.lists).toHaveLength(1);

    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const kurtList = await kurt.get(`/conversations/${conversationId}/request-lists`);
    expect(kurtList.status).toBe(403);
  });
});

describe('end-to-end happy path', () => {
  it('create → post message with linkage → auto-submit → mark-done → list completes', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const bob = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    // Seed a conversation key so messages can be inserted (needed by some flows).
    const { db } = await import('../db/knex.js');
    await db('conversation_keys')
      .insert({
        conversation_id: conversationId,
        rotation_version: 1,
        wrapped_keys: JSON.stringify({}),
      })
      .onConflict(['conversation_id', 'rotation_version'])
      .ignore();
    // 1) Alice creates a list with 1 text-only item.
    const created = await alice.post(`/conversations/${conversationId}/request-lists`).send({
      title: 'Quick check-in',
      items: [
        { titleCiphertext: b64('confirm address'), contentKeyVersion: 1, responseType: 'text' },
      ],
    });
    expect(created.status).toBe(201);
    const listId: string = created.body.list.id;
    const itemId: string = created.body.list.items[0].id;

    // 2) Bob (the other member) posts a message with the linkage in
    //    ciphertextMeta. The post-insert hook should auto-flip the item.
    const post = await bob.post(`/conversations/${conversationId}/messages`).send({
      ciphertext: b64('updated address'),
      contentKeyVersion: 1,
      ciphertextMeta: { requestItemId: itemId },
    });
    expect(post.status).toBe(201);

    // The hook fires fire-and-forget — give it a moment, then confirm status.
    await new Promise((r) => setTimeout(r, 200));
    const fetched = await alice.get(`/request-lists/${listId}`);
    expect(fetched.status).toBe(200);
    const item = fetched.body.list.items.find((i: { id: string }) => i.id === itemId);
    expect(item.status).toBe('submitted');
    expect(item.submittedAt).not.toBeNull();

    // 3) Alice marks the item done. List has only one item, so it should
    //    auto-complete.
    const done = await alice.post(`/request-items/${itemId}/mark-done`);
    expect(done.status).toBe(200);
    expect(done.body.item.status).toBe('done');
    expect(done.body.listCompleted).toBe(true);

    const finalList = await alice.get(`/request-lists/${listId}`);
    expect(finalList.body.list.status).toBe('completed');
  });

  it('mark-done fails with 409 from a pending item', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const created = await alice.post(`/conversations/${conversationId}/request-lists`).send({
      title: 'L',
      items: [{ titleCiphertext: b64('x'), contentKeyVersion: 1, responseType: 'text' }],
    });
    const itemId: string = created.body.list.items[0].id;
    const r = await alice.post(`/request-items/${itemId}/mark-done`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('bad_state');
  });
});

describe('POST /request-items/:id/request-revision', () => {
  it('posts a system message and flips item to revision', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const bob = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    const { db } = await import('../db/knex.js');
    await db('conversation_keys')
      .insert({
        conversation_id: conversationId,
        rotation_version: 1,
        wrapped_keys: JSON.stringify({}),
      })
      .onConflict(['conversation_id', 'rotation_version'])
      .ignore();
    const created = await alice.post(`/conversations/${conversationId}/request-lists`).send({
      title: 'L',
      items: [{ titleCiphertext: b64('x'), contentKeyVersion: 1, responseType: 'text' }],
    });
    const itemId: string = created.body.list.items[0].id;
    // Submit it.
    await bob.post(`/conversations/${conversationId}/messages`).send({
      ciphertext: b64('reply'),
      contentKeyVersion: 1,
      ciphertextMeta: { requestItemId: itemId },
    });
    await new Promise((r) => setTimeout(r, 200));
    // Request revision.
    const rev = await alice.post(`/request-items/${itemId}/request-revision`).send({
      noteCiphertext: b64('please redo'),
      contentKeyVersion: 1,
    });
    expect(rev.status).toBe(200);
    expect(rev.body.item.status).toBe('revision');
    expect(rev.body.item.revisionNoteCiphertext).toBe(b64('please redo'));
    // System message should have landed in the thread.
    const sysMsgs = await db('messages')
      .where({ conversation_id: conversationId, source: 'system' })
      .select('*');
    expect(sysMsgs.length).toBeGreaterThan(0);
    const meta = sysMsgs[0]!.ciphertext_meta as Record<string, unknown>;
    expect(meta.systemEventType).toBe('request_item_revision');
    expect(meta.requestItemId).toBe(itemId);
    expect(meta.revisionNoteCiphertext).toBe(b64('please redo'));
  });
});

describe('POST /request-items/:id/link-message', () => {
  it('patches an existing message`s ciphertextMeta with the item id', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const bob = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    const { db } = await import('../db/knex.js');
    await db('conversation_keys')
      .insert({
        conversation_id: conversationId,
        rotation_version: 1,
        wrapped_keys: JSON.stringify({}),
      })
      .onConflict(['conversation_id', 'rotation_version'])
      .ignore();
    const created = await alice.post(`/conversations/${conversationId}/request-lists`).send({
      title: 'L',
      items: [{ titleCiphertext: b64('x'), contentKeyVersion: 1, responseType: 'text' }],
    });
    const itemId: string = created.body.list.items[0].id;
    // Bob posts an unrelated message (no requestItemId set).
    const post = await bob.post(`/conversations/${conversationId}/messages`).send({
      ciphertext: b64('mentioned the address inline'),
      contentKeyVersion: 1,
      ciphertextMeta: {},
    });
    const messageId: string = post.body.id;
    // Alice retro-links it.
    const link = await alice.post(`/request-items/${itemId}/link-message`).send({ messageId });
    expect(link.status).toBe(200);
    const msg = await db('messages').where({ id: messageId }).first();
    expect((msg!.ciphertext_meta as Record<string, unknown>).requestItemId).toBe(itemId);
  });

  it('rejects with 404 if the message does not exist', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const created = await alice.post(`/conversations/${conversationId}/request-lists`).send({
      title: 'L',
      items: [{ titleCiphertext: b64('x'), contentKeyVersion: 1, responseType: 'text' }],
    });
    const itemId: string = created.body.list.items[0].id;
    const r = await alice
      .post(`/request-items/${itemId}/link-message`)
      .send({ messageId: '00000000-0000-0000-0000-000000000000' });
    expect(r.status).toBe(404);
  });
});

describe('templates', () => {
  it('CRUD via /request-templates (admin only on writes)', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    // Create (admin)
    const create = await kurt.post('/request-templates').send({
      name: 'Year-end',
      description: 'Standard 1040',
      itemSpecs: [
        { title: 'W-2', responseType: 'file', sortOrder: 0 },
        { title: '1099-INT', responseType: 'file', sortOrder: 1 },
      ],
    });
    expect(create.status).toBe(201);
    const id: string = create.body.template.id;
    // Read (any staff)
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const read = await alice.get('/request-templates');
    expect(read.body.templates.find((t: { id: string }) => t.id === id)).toBeTruthy();
    // Update (admin)
    const upd = await kurt.patch(`/request-templates/${id}`).send({ name: 'Year-end (1040)' });
    expect(upd.body.template.name).toBe('Year-end (1040)');
    // Archive (admin)
    const del = await kurt.delete(`/request-templates/${id}`);
    expect(del.status).toBe(200);
    // Now invisible from the list endpoint.
    const read2 = await kurt.get('/request-templates');
    expect(read2.body.templates.find((t: { id: string }) => t.id === id)).toBeUndefined();
  });

  it('non-admin staff cannot create / patch / archive templates', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.post('/request-templates').send({
      name: 'sneaky',
      itemSpecs: [{ title: 'a', responseType: 'text', sortOrder: 0 }],
    });
    expect(r.status).toBe(403);
  });

  it('rejects duplicate active template names with 409', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    await kurt.post('/request-templates').send({
      name: 'dup',
      itemSpecs: [{ title: 'a', responseType: 'text', sortOrder: 0 }],
    });
    const r = await kurt.post('/request-templates').send({
      name: 'dup',
      itemSpecs: [{ title: 'b', responseType: 'text', sortOrder: 0 }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('unique_violation');
  });
});

describe('GET /requests/dashboard', () => {
  it('returns rows for the caller’s conversations with item counts + due chip data', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const { db } = await import('../db/knex.js');
    await db('conversation_keys')
      .insert({
        conversation_id: conversationId,
        rotation_version: 1,
        wrapped_keys: JSON.stringify({}),
      })
      .onConflict(['conversation_id', 'rotation_version'])
      .ignore();
    // Alice's own list (members include her).
    const created = await alice.post(`/conversations/${conversationId}/request-lists`).send({
      title: 'Q1 close',
      dueDate: '2026-04-30',
      items: [
        { titleCiphertext: b64('a'), contentKeyVersion: 1, responseType: 'text' },
        { titleCiphertext: b64('b'), contentKeyVersion: 1, responseType: 'text' },
      ],
    });
    const listId: string = created.body.list.id;

    // A second conversation (kurt-only) — Alice should NOT see its lists.
    const [otherConv] = await db('conversations').insert({ type: 'internal' }).returning(['id']);
    await db('conversation_members').insert({
      conversation_id: otherConv.id,
      user_id: userIds.kurt,
    });
    await db('conversation_keys').insert({
      conversation_id: otherConv.id,
      rotation_version: 1,
      wrapped_keys: JSON.stringify({}),
    });
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    await kurt.post(`/conversations/${otherConv.id}/request-lists`).send({
      title: 'Kurt-only',
      items: [{ titleCiphertext: b64('x'), contentKeyVersion: 1, responseType: 'text' }],
    });

    const dash = await alice.get('/requests/dashboard');
    expect(dash.status).toBe(200);
    const ids = dash.body.rows.map((r: { list: { id: string } }) => r.list.id);
    expect(ids).toContain(listId);
    expect(ids).not.toContain(otherConv.id);
    const myRow = dash.body.rows.find((r: { list: { id: string } }) => r.list.id === listId);
    expect(myRow.itemCounts.pending).toBe(2);
    expect(myRow.itemCounts.submitted).toBe(0);
    expect(myRow.list.dueDate).toBe('2026-04-30');
  });

  it('rejects unauthenticated requests with 401', async () => {
    const r = await request(app).get('/requests/dashboard');
    expect(r.status).toBe(401);
  });
});

describe('Phase 24 security follow-ups', () => {
  it('GET /portal/request-lists withholds data when step-up is required', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const { db } = await import('../db/knex.js');
    // External conversation with a verification-required identity whose session
    // hasn't satisfied step-up.
    const [extConv] = await db('conversations').insert({ type: 'external' }).returning(['id']);
    const [identity] = await db('external_identities')
      .insert({
        email: `stepup-${Date.now()}@example.test`,
        display_name: 'Step-up client',
        verification_type: 'ssn',
        verification_required: true,
        verification_last4_hash: 'fake-hash',
      })
      .returning(['id']);
    await db('conversation_members').insert([
      { conversation_id: extConv.id, user_id: userIds.alice },
      { conversation_id: extConv.id, external_identity_id: identity.id },
    ]);
    await db('conversation_keys').insert({
      conversation_id: extConv.id,
      rotation_version: 1,
      wrapped_keys: JSON.stringify({}),
    });
    await alice.post(`/conversations/${extConv.id}/request-lists`).send({
      title: 'Should be withheld',
      items: [{ titleCiphertext: b64('x'), contentKeyVersion: 1, responseType: 'text' }],
    });
    const { randomBytes, createHash } = await import('node:crypto');
    const tokenRaw = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(tokenRaw).digest('hex');
    // verified_until = null → step-up needed
    await db('client_sessions').insert({
      external_identity_id: identity.id,
      session_token_hash: tokenHash,
      absolute_expires_at: new Date(Date.now() + 60_000).toISOString(),
      verified_until: null,
    });
    const r = await request(app)
      .get('/portal/request-lists')
      .set('Cookie', `vibe.portal=${tokenRaw}`);
    expect(r.status).toBe(200);
    expect(r.body.lists).toEqual([]);
    expect(r.body.stepupRequired).toBe(true);
  });

  it('rejects an attachment upload past the per-message cap (Phase 24.5 server cap)', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const { db } = await import('../db/knex.js');
    await db('conversation_keys')
      .insert({
        conversation_id: conversationId,
        rotation_version: 1,
        wrapped_keys: JSON.stringify({}),
      })
      .onConflict(['conversation_id', 'rotation_version'])
      .ignore();
    const post = await alice.post(`/conversations/${conversationId}/messages`).send({
      ciphertext: b64('hi'),
      contentKeyVersion: 1,
      ciphertextMeta: {},
    });
    expect(post.status).toBe(201);
    const messageId: string = post.body.id;
    // Pre-load 10 attachments directly to skip multipart upload churn.
    const rows = Array.from({ length: 10 }, (_, i) => ({
      message_id: messageId,
      filename_ciphertext: `cap-${i}`,
      mime_type: 'image/jpeg',
      size_bytes: 1,
      storage_path: `cap-${i}`,
      wrapped_file_key: Buffer.from(''),
      scan_status: 'clean',
      envelope_format: 'conversation-key-v1',
    }));
    await db('attachments').insert(rows);
    // 11th attempt should refuse with 409.
    const r = await alice
      .post(`/conversations/${conversationId}/attachments`)
      .field('messageId', messageId)
      .field('filenameCiphertext', 'overflow')
      .field('wrappedFileKey', 'AAAA')
      .attach('file', Buffer.from('payload'), {
        filename: 'overflow.bin',
        contentType: 'application/octet-stream',
      });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('attachment_limit_reached');
  });

  it('caps the revision-note ciphertext to 3 KiB (system-message echo budget)', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const bob = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    const { db } = await import('../db/knex.js');
    await db('conversation_keys')
      .insert({
        conversation_id: conversationId,
        rotation_version: 1,
        wrapped_keys: JSON.stringify({}),
      })
      .onConflict(['conversation_id', 'rotation_version'])
      .ignore();
    const created = await alice.post(`/conversations/${conversationId}/request-lists`).send({
      title: 'L',
      items: [{ titleCiphertext: b64('x'), contentKeyVersion: 1, responseType: 'text' }],
    });
    const itemId: string = created.body.list.items[0].id;
    await bob.post(`/conversations/${conversationId}/messages`).send({
      ciphertext: b64('reply'),
      contentKeyVersion: 1,
      ciphertextMeta: { requestItemId: itemId },
    });
    await new Promise((r) => setTimeout(r, 200));
    // 3073 base64 chars triggers the cap (limit is 3072).
    const oversized = 'A'.repeat(3072) + 'A';
    const r = await alice.post(`/request-items/${itemId}/request-revision`).send({
      noteCiphertext: oversized,
      contentKeyVersion: 1,
    });
    expect(r.status).toBe(400);
  });
});

describe('Phase 24 kill switch (firm_settings.requests_enabled)', () => {
  // Restore the toggle after each test so following describes (and other
  // suites running after this one) see the default-on state.
  afterAll(async () => {
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({ requests_enabled: true });
  });

  it('staff list-creation is blocked with 403 when disabled', async () => {
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({ requests_enabled: false });
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.post(`/conversations/${conversationId}/request-lists`).send({
      title: 'denied',
      items: [{ titleCiphertext: b64('x'), contentKeyVersion: 1, responseType: 'text' }],
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('requests_disabled');
    await db('firm_settings').where({ id: 1 }).update({ requests_enabled: true });
  });

  it('staff dashboard is blocked with 403 when disabled', async () => {
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({ requests_enabled: false });
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.get('/requests/dashboard');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('requests_disabled');
    await db('firm_settings').where({ id: 1 }).update({ requests_enabled: true });
  });

  it('GET /firm/security-policy reflects the toggle', async () => {
    const { db } = await import('../db/knex.js');
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    await db('firm_settings').where({ id: 1 }).update({ requests_enabled: false });
    const off = await kurt.get('/firm/security-policy');
    expect(off.status).toBe(200);
    expect(off.body.requestsEnabled).toBe(false);
    await db('firm_settings').where({ id: 1 }).update({ requests_enabled: true });
    const on = await kurt.get('/firm/security-policy');
    expect(on.body.requestsEnabled).toBe(true);
  });

  it('PATCH /admin/settings { requestsEnabled } persists the flag', async () => {
    const { db } = await import('../db/knex.js');
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const off = await kurt
      .patch('/admin/settings')
      .send({ requestsEnabled: false });
    expect(off.status).toBe(200);
    const row = await db('firm_settings').where({ id: 1 }).first('requests_enabled');
    expect(row.requests_enabled).toBe(false);
    await kurt.patch('/admin/settings').send({ requestsEnabled: true });
  });

  it('portal endpoint returns requestsDisabled:true with empty list when off', async () => {
    const { db } = await import('../db/knex.js');
    // Build a session up front while the feature is still enabled (so list
    // creation succeeds) — then flip the kill switch and re-fetch.
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const [extConv] = await db('conversations')
      .insert({ type: 'external' })
      .returning(['id']);
    const [identity] = await db('external_identities')
      .insert({
        email: `kill-${Date.now()}@example.test`,
        display_name: 'Kill switch client',
        verification_type: 'none',
        verification_required: false,
      })
      .returning(['id']);
    await db('conversation_members').insert([
      { conversation_id: extConv.id, user_id: userIds.alice },
      { conversation_id: extConv.id, external_identity_id: identity.id },
    ]);
    await db('conversation_keys').insert({
      conversation_id: extConv.id,
      rotation_version: 1,
      wrapped_keys: JSON.stringify({}),
    });
    await alice.post(`/conversations/${extConv.id}/request-lists`).send({
      title: 'will be hidden',
      items: [{ titleCiphertext: b64('x'), contentKeyVersion: 1, responseType: 'text' }],
    });
    const { randomBytes, createHash } = await import('node:crypto');
    const tokenRaw = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(tokenRaw).digest('hex');
    await db('client_sessions').insert({
      external_identity_id: identity.id,
      session_token_hash: tokenHash,
      absolute_expires_at: new Date(Date.now() + 60_000).toISOString(),
      verified_until: new Date(Date.now() + 60_000).toISOString(),
    });
    await db('firm_settings').where({ id: 1 }).update({ requests_enabled: false });
    const r = await request(app)
      .get('/portal/request-lists')
      .set('Cookie', `vibe.portal=${tokenRaw}`);
    expect(r.status).toBe(200);
    expect(r.body.requestsDisabled).toBe(true);
    expect(r.body.lists).toEqual([]);
    await db('firm_settings').where({ id: 1 }).update({ requests_enabled: true });
  });
});

describe('GET /portal/request-lists', () => {
  it('returns active lists for an external_identity that is a conversation member', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const { db } = await import('../db/knex.js');
    // Make an external conversation with Bob and an external identity.
    const [extConv] = await db('conversations')
      .insert({ type: 'external' })
      .returning(['id']);
    const [identity] = await db('external_identities')
      .insert({
        email: `client-${Date.now()}@example.test`,
        display_name: 'Test Client',
        verification_type: 'none',
        verification_required: false,
      })
      .returning(['id']);
    await db('conversation_members').insert([
      { conversation_id: extConv.id, user_id: userIds.alice },
      { conversation_id: extConv.id, external_identity_id: identity.id },
    ]);
    await db('conversation_keys').insert({
      conversation_id: extConv.id,
      rotation_version: 1,
      wrapped_keys: JSON.stringify({}),
    });
    // Alice creates a list for it.
    await alice.post(`/conversations/${extConv.id}/request-lists`).send({
      title: 'Portal-visible list',
      items: [{ titleCiphertext: b64('item'), contentKeyVersion: 1, responseType: 'text' }],
    });
    // Forge a portal session cookie for the test by inserting a row directly.
    const { randomBytes, createHash } = await import('node:crypto');
    const tokenRaw = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(tokenRaw).digest('hex');
    await db('client_sessions').insert({
      external_identity_id: identity.id,
      session_token_hash: tokenHash,
      absolute_expires_at: new Date(Date.now() + 60_000).toISOString(),
      verified_until: new Date(Date.now() + 60_000).toISOString(),
    });
    // Hit the portal endpoint with the raw token in the cookie.
    const r = await request(app)
      .get('/portal/request-lists')
      .set('Cookie', `vibe.portal=${tokenRaw}`);
    expect(r.status).toBe(200);
    expect(r.body.lists).toHaveLength(1);
    expect(r.body.lists[0].title).toBe('Portal-visible list');
  });
});
