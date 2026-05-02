/**
 * Phase 24.1 — Unit/integration tests for the requests service state machine.
 *
 * Hits the real test DB (resetTestDb()) but bypasses HTTP entirely. We
 * exercise the service module directly and assert: (a) every state
 * transition lands the right status + timestamps, (b) every guard rejects,
 * (c) every transition writes a paired audit_log row.
 *
 * Routes / realtime publishes / system messages are out of scope here —
 * those live in 24.2.
 *
 * Seeded users (apps/server/src/db/seeds/01_groups_and_users.js):
 *   alice  (non-admin)  bob (non-admin)  kurt (admin)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetTestDb } from './test-helpers.js';

interface SeedUserIds {
  kurt: string;
  alice: string;
  bob: string;
}

let userIds: SeedUserIds;
let conversationId: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
  const { db } = await import('../db/knex.js');
  const rows = await db('users')
    .whereIn('username', ['kurt', 'alice', 'bob'])
    .select('id', 'username');
  userIds = Object.fromEntries(rows.map((r) => [r.username, r.id])) as SeedUserIds;
}, 120_000);

afterAll(async () => {
  // Pool stays open for other test files (harness pattern from auth.test.ts).
});

beforeEach(async () => {
  const { db } = await import('../db/knex.js');
  // Wipe Phase 24 tables per-test; conversations/members/audit_log are
  // recreated as needed.
  await db('request_items').del();
  await db('request_lists').del();
  await db('request_templates').del();
  await db('audit_log').del();
  await db('messages').del();
  await db('conversation_members').del();
  await db('conversation_keys').del();
  await db('conversations').del();
  // A two-staff conversation. Alice + Bob members; Kurt is non-member.
  const [conv] = await db('conversations').insert({ type: 'internal' }).returning(['id']);
  conversationId = conv.id;
  await db('conversation_members').insert([
    { conversation_id: conversationId, user_id: userIds.alice },
    { conversation_id: conversationId, user_id: userIds.bob },
  ]);
  // Phase 24 follow-up: seed a conversation_keys row at rotation_version=1
  // so contentKeyVersion validation passes. The wrapped_keys JSON is empty —
  // tests use the row only as a `(conversation_id, rotation_version)`
  // existence proof, not for actual unwrap.
  await db('conversation_keys').insert({
    conversation_id: conversationId,
    rotation_version: 1,
    wrapped_keys: JSON.stringify({}),
  });
});

// Helpers -------------------------------------------------------------------

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function listAuditActions(targetId?: string): Promise<string[]> {
  const { db } = await import('../db/knex.js');
  let q = db('audit_log').select('action').orderBy('created_at');
  if (targetId) q = q.where({ target_id: targetId });
  const rows = await q;
  return rows.map((r) => r.action as string);
}

async function makeListWithItems(): Promise<{
  listId: string;
  itemIds: string[];
}> {
  const svc = await import('../services/requestsService.js');
  const result = await svc.createList({
    conversationId,
    createdBy: userIds.alice,
    title: '2024 Tax Documents',
    description: 'Year-end intake',
    dueDate: '2026-04-30',
    items: [
      {
        titleCiphertext: b64('w-2 ciphertext'),
        contentKeyVersion: 1,
        responseType: 'file',
      },
      {
        titleCiphertext: b64('1099 ciphertext'),
        contentKeyVersion: 1,
        responseType: 'both',
      },
      {
        titleCiphertext: b64('confirm address ciphertext'),
        contentKeyVersion: 1,
        responseType: 'text',
      },
    ],
  });
  return { listId: result.id, itemIds: result.items.map((i) => i.id) };
}

// Tests ---------------------------------------------------------------------

describe('createList', () => {
  it('creates a list and seeds items atomically and audits', async () => {
    const svc = await import('../services/requestsService.js');
    const list = await svc.createList({
      conversationId,
      createdBy: userIds.alice,
      title: 'Year-end',
      items: [
        {
          titleCiphertext: b64('item one'),
          contentKeyVersion: 1,
          responseType: 'both',
        },
      ],
    });
    expect(list.title).toBe('Year-end');
    expect(list.status).toBe('active');
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.titleCiphertext).toBe(b64('item one'));
    expect(await listAuditActions(list.id)).toEqual(['request.list_created']);
  });

  it('rejects a non-member', async () => {
    const svc = await import('../services/requestsService.js');
    await expect(
      svc.createList({
        conversationId,
        createdBy: userIds.kurt, // not a member of this conversation
        title: 'Year-end',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects an archived template', async () => {
    const svc = await import('../services/requestsService.js');
    const tmpl = await svc.createTemplate(
      {
        name: 'archived',
        itemSpecs: [{ title: 't', responseType: 'text', sortOrder: 0 }],
      },
      userIds.alice,
    );
    await svc.archiveTemplate(tmpl.id, userIds.alice);
    await expect(
      svc.createList({
        conversationId,
        createdBy: userIds.alice,
        title: 'using archived',
        templateId: tmpl.id,
      }),
    ).rejects.toMatchObject({ code: 'template_archived' });
  });
});

describe('addItem / updateItem / deletePendingItem', () => {
  it('adds an item to an active list and audits', async () => {
    const svc = await import('../services/requestsService.js');
    const { listId } = await makeListWithItems();
    const item = await svc.addItem(
      listId,
      {
        titleCiphertext: b64('extra item'),
        contentKeyVersion: 1,
        responseType: 'text',
      },
      userIds.alice,
    );
    expect(item.status).toBe('pending');
    const audits = await listAuditActions(item.id);
    expect(audits).toContain('request.item_created');
  });

  it('refuses to add an item to a cancelled list', async () => {
    const svc = await import('../services/requestsService.js');
    const { listId } = await makeListWithItems();
    await svc.cancelList(listId, userIds.alice);
    await expect(
      svc.addItem(
        listId,
        {
          titleCiphertext: b64('late item'),
          contentKeyVersion: 1,
          responseType: 'text',
        },
        userIds.alice,
      ),
    ).rejects.toMatchObject({ code: 'bad_state' });
  });

  it('updates a ciphertext field with new content_key_version', async () => {
    const svc = await import('../services/requestsService.js');
    const { itemIds } = await makeListWithItems();
    // Seed v2 in conversation_keys so the contentKeyVersion validation passes.
    const { db } = await import('../db/knex.js');
    await db('conversation_keys').insert({
      conversation_id: conversationId,
      rotation_version: 2,
      wrapped_keys: JSON.stringify({}),
    });
    const updated = await svc.updateItem(
      itemIds[0]!,
      { titleCiphertext: b64('rewritten title'), contentKeyVersion: 2 },
      userIds.alice,
    );
    expect(updated.titleCiphertext).toBe(b64('rewritten title'));
    expect(updated.contentKeyVersion).toBe(2);
  });

  it('deletePendingItem rejects non-pending items', async () => {
    const svc = await import('../services/requestsService.js');
    const { itemIds, listId } = await makeListWithItems();
    // Move one item to submitted via the message hook.
    const { db } = await import('../db/knex.js');
    const [msg] = await db('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: userIds.alice,
        ciphertext: Buffer.from('x'),
        content_key_version: 1,
        ciphertext_meta: { requestItemId: itemIds[2]! },
      })
      .returning('*');
    await svc.onMessagePosted({
      messageId: msg.id,
      itemId: itemIds[2]!,
      conversationId,
      attachmentCount: 0,
      hasTextBody: true,
      actorUserId: userIds.alice,
      actorExternalIdentityId: null,
    });
    await expect(svc.deletePendingItem(itemIds[2]!, userIds.alice)).rejects.toMatchObject({
      code: 'item_pending_only',
    });
    // Sibling pending item still deletable.
    await svc.deletePendingItem(itemIds[0]!, userIds.alice);
    const remaining = await db('request_items').where({ list_id: listId });
    expect(remaining.map((r) => r.id)).not.toContain(itemIds[0]!);
  });
});

describe('onMessagePosted (auto-flip on linked message)', () => {
  it('flips pending → submitted for response_type=text on text reply', async () => {
    const svc = await import('../services/requestsService.js');
    const { itemIds } = await makeListWithItems(); // item[2] is response_type=text
    const { db } = await import('../db/knex.js');
    const [msg] = await db('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: userIds.bob,
        ciphertext: Buffer.from('reply'),
        content_key_version: 1,
        ciphertext_meta: { requestItemId: itemIds[2]! },
      })
      .returning('*');
    const updated = await svc.onMessagePosted({
      messageId: msg.id,
      itemId: itemIds[2]!,
      conversationId,
      attachmentCount: 0,
      hasTextBody: true,
      actorUserId: userIds.bob,
      actorExternalIdentityId: null,
    });
    expect(updated?.status).toBe('submitted');
    expect(await listAuditActions(itemIds[2]!)).toContain('request.item_submitted');
  });

  it('does NOT flip when response_type=file and no attachments', async () => {
    const svc = await import('../services/requestsService.js');
    const { itemIds } = await makeListWithItems(); // item[0] is response_type=file
    const { db } = await import('../db/knex.js');
    const [msg] = await db('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: userIds.bob,
        ciphertext: Buffer.from('text only'),
        content_key_version: 1,
        ciphertext_meta: { requestItemId: itemIds[0]! },
      })
      .returning('*');
    const updated = await svc.onMessagePosted({
      messageId: msg.id,
      itemId: itemIds[0]!,
      conversationId,
      attachmentCount: 0,
      hasTextBody: true,
      actorUserId: userIds.bob,
      actorExternalIdentityId: null,
    });
    expect(updated).toBeNull();
    const item = await (
      await import('../repositories/requests.js')
    ).requestItemsRepo.byId(itemIds[0]!);
    expect(item?.status).toBe('pending');
  });

  it('rejects (and audits) when itemId belongs to another conversation', async () => {
    const svc = await import('../services/requestsService.js');
    const { itemIds } = await makeListWithItems();
    const { db } = await import('../db/knex.js');
    // Make a SECOND conversation that bob is not a member of, in which we
    // post a message claiming the item from the first conversation.
    const [otherConv] = await db('conversations').insert({ type: 'internal' }).returning(['id']);
    await db('conversation_members').insert([
      { conversation_id: otherConv.id, user_id: userIds.bob },
      { conversation_id: otherConv.id, user_id: userIds.alice },
    ]);
    const [msg] = await db('messages')
      .insert({
        conversation_id: otherConv.id,
        sender_id: userIds.bob,
        ciphertext: Buffer.from('attempted hijack'),
        content_key_version: 1,
        ciphertext_meta: { requestItemId: itemIds[2]! },
      })
      .returning('*');
    const updated = await svc.onMessagePosted({
      messageId: msg.id,
      itemId: itemIds[2]!,
      conversationId: otherConv.id,
      attachmentCount: 0,
      hasTextBody: true,
      actorUserId: userIds.bob,
      actorExternalIdentityId: null,
    });
    expect(updated).toBeNull();
    expect(await listAuditActions(itemIds[2]!)).toContain('request.item_link_rejected');
  });

  it('refuses to flip when the parent list is cancelled (Phase 24 follow-up)', async () => {
    const svc = await import('../services/requestsService.js');
    const { listId, itemIds } = await makeListWithItems();
    await svc.cancelList(listId, userIds.alice);
    const result = await svc.onMessagePosted({
      messageId: '00000000-0000-0000-0000-000000000099',
      itemId: itemIds[2]!,
      conversationId,
      attachmentCount: 0,
      hasTextBody: true,
      actorUserId: userIds.bob,
      actorExternalIdentityId: null,
    });
    expect(result).toBeNull();
    const audits = await listAuditActions(itemIds[2]!);
    // The skip should write a `request.item_link_rejected` audit row tagged
    // with reason=list_inactive. Without this, the cancelled-list flow would
    // leave staff with submitted items under a dead list.
    expect(audits).toContain('request.item_link_rejected');
  });

  it('refuses to re-promote when a sibling attachment of the same message is infected', async () => {
    const svc = await import('../services/requestsService.js');
    const { itemIds } = await makeListWithItems();
    const { db } = await import('../db/knex.js');
    // Insert a message linked to item[1] (response_type=both) and seed the
    // attachments table with one CLEAN attachment (would normally re-promote)
    // and one INFECTED attachment (the sticky-revert sentinel).
    const [msg] = await db('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: userIds.bob,
        ciphertext: Buffer.from('reply'),
        content_key_version: 1,
        ciphertext_meta: { requestItemId: itemIds[1]! },
      })
      .returning('*');
    await db('attachments').insert([
      {
        message_id: msg.id,
        filename_ciphertext: 'fn1',
        mime_type: 'image/jpeg',
        size_bytes: 100,
        storage_path: 'k1',
        wrapped_file_key: Buffer.from(''),
        scan_status: 'clean',
        envelope_format: 'conversation-key-v1',
      },
      {
        message_id: msg.id,
        filename_ciphertext: 'fn2',
        mime_type: 'image/jpeg',
        size_bytes: 100,
        storage_path: 'k2',
        wrapped_file_key: Buffer.from(''),
        scan_status: 'infected',
        envelope_format: 'conversation-key-v1',
      },
    ]);
    const result = await svc.onMessagePosted({
      messageId: msg.id,
      itemId: itemIds[1]!,
      conversationId,
      attachmentCount: 2,
      hasTextBody: true,
      actorUserId: userIds.bob,
      actorExternalIdentityId: null,
    });
    expect(result).toBeNull();
    const audits = await listAuditActions(itemIds[1]!);
    expect(audits).toContain('request.item_link_rejected');
  });

  it('idempotent: a second call with the same item is a no-op', async () => {
    const svc = await import('../services/requestsService.js');
    const { itemIds } = await makeListWithItems();
    const args = {
      messageId: '00000000-0000-0000-0000-000000000001',
      itemId: itemIds[2]!,
      conversationId,
      attachmentCount: 0,
      hasTextBody: true,
      actorUserId: userIds.bob,
      actorExternalIdentityId: null,
    };
    const first = await svc.onMessagePosted(args);
    expect(first?.status).toBe('submitted');
    const second = await svc.onMessagePosted({
      ...args,
      messageId: '00000000-0000-0000-0000-000000000002',
    });
    expect(second).toBeNull(); // already submitted, no transition fires
  });
});

describe('onAttachmentScanFailed (Phase 24.5 revert)', () => {
  // Helper that takes the standard 3-item list and submits item[2] (response_type=text)
  // via a synthetic message linkage so we have something in 'submitted' to revert.
  async function submitTextItem(): Promise<{ itemId: string; messageId: string }> {
    const svc = await import('../services/requestsService.js');
    const { itemIds } = await makeListWithItems();
    const { db } = await import('../db/knex.js');
    const [msg] = await db('messages')
      .insert({
        conversation_id: conversationId,
        sender_external_identity_id: null,
        sender_id: userIds.bob,
        ciphertext: Buffer.from('ok'),
        content_key_version: 1,
        ciphertext_meta: { requestItemId: itemIds[2]! },
      })
      .returning('*');
    await svc.onMessagePosted({
      messageId: msg.id,
      itemId: itemIds[2]!,
      conversationId,
      attachmentCount: 0,
      hasTextBody: true,
      actorUserId: userIds.bob,
      actorExternalIdentityId: null,
    });
    return { itemId: itemIds[2]!, messageId: msg.id };
  }

  it('walks a submitted item back to revision and audits', async () => {
    const svc = await import('../services/requestsService.js');
    const { itemId, messageId } = await submitTextItem();
    const result = await svc.onAttachmentScanFailed({
      messageId,
      itemId,
      conversationId,
      reason: 'infected',
      actorUserId: userIds.bob,
      actorExternalIdentityId: null,
    });
    expect(result?.status).toBe('revision');
    expect(result?.revisionNoteCiphertext).toBeNull();
    const audits = await listAuditActions(itemId);
    expect(audits).toContain('request.item_scan_failed');
  });

  it('is a no-op for items not in `submitted`', async () => {
    const svc = await import('../services/requestsService.js');
    const { itemIds } = await makeListWithItems();
    // item[0] is still pending — no auto-submit fired.
    const result = await svc.onAttachmentScanFailed({
      messageId: '00000000-0000-0000-0000-000000000099',
      itemId: itemIds[0]!,
      conversationId,
      reason: 'infected',
      actorUserId: userIds.bob,
      actorExternalIdentityId: null,
    });
    expect(result).toBeNull();
  });

  it('rejects when the item lives in another conversation', async () => {
    const svc = await import('../services/requestsService.js');
    const { itemId, messageId } = await submitTextItem();
    const result = await svc.onAttachmentScanFailed({
      messageId,
      itemId,
      conversationId: '00000000-0000-0000-0000-000000000abc',
      reason: 'infected',
      actorUserId: userIds.bob,
      actorExternalIdentityId: null,
    });
    expect(result).toBeNull();
  });
});

describe('markDone + auto-complete list', () => {
  it('transitions submitted → done and audits', async () => {
    const svc = await import('../services/requestsService.js');
    const { itemIds } = await makeListWithItems();
    // Submit item[2] first.
    await svc.onMessagePosted({
      messageId: '00000000-0000-0000-0000-000000000010',
      itemId: itemIds[2]!,
      conversationId,
      attachmentCount: 0,
      hasTextBody: true,
      actorUserId: userIds.bob,
      actorExternalIdentityId: null,
    });
    const result = await svc.markDone(itemIds[2]!, userIds.alice);
    expect(result.item.status).toBe('done');
    expect(result.item.completedBy).toBe(userIds.alice);
    expect(result.listCompleted).toBe(false);
    expect(await listAuditActions(itemIds[2]!)).toContain('request.item_marked_done');
  });

  it('rejects mark-done from pending state', async () => {
    const svc = await import('../services/requestsService.js');
    const { itemIds } = await makeListWithItems();
    await expect(svc.markDone(itemIds[0]!, userIds.alice)).rejects.toMatchObject({
      code: 'bad_state',
    });
  });

  it('auto-completes the list when the last item flips to done', async () => {
    const svc = await import('../services/requestsService.js');
    const { listId, itemIds } = await makeListWithItems();
    // Submit + mark-done all three.
    for (const [i, itemId] of itemIds.entries()) {
      await svc.onMessagePosted({
        messageId: `00000000-0000-0000-0000-00000000010${i}`,
        itemId,
        conversationId,
        attachmentCount: 1,
        hasTextBody: true,
        actorUserId: userIds.bob,
        actorExternalIdentityId: null,
      });
      await svc.markDone(itemId, userIds.alice);
    }
    const finalList = await svc.getListWithItems(listId, userIds.alice);
    expect(finalList.status).toBe('completed');
    expect(finalList.completedAt).not.toBeNull();
    const audits = await listAuditActions(listId);
    expect(audits).toContain('request.list_completed');
  });
});

describe('requestRevision', () => {
  it('transitions submitted → revision and stores the note ciphertext', async () => {
    const svc = await import('../services/requestsService.js');
    const { itemIds } = await makeListWithItems();
    await svc.onMessagePosted({
      messageId: '00000000-0000-0000-0000-000000000020',
      itemId: itemIds[2]!,
      conversationId,
      attachmentCount: 0,
      hasTextBody: true,
      actorUserId: userIds.bob,
      actorExternalIdentityId: null,
    });
    const updated = await svc.requestRevision(
      itemIds[2]!,
      b64('please re-do this'),
      1,
      userIds.alice,
    );
    expect(updated.status).toBe('revision');
    expect(updated.revisionNoteCiphertext).toBe(b64('please re-do this'));
    expect(await listAuditActions(itemIds[2]!)).toContain('request.item_revision_requested');
  });

  it('reopens a completed list when revision is requested on a done item', async () => {
    const svc = await import('../services/requestsService.js');
    const { listId, itemIds } = await makeListWithItems();
    for (const [i, itemId] of itemIds.entries()) {
      await svc.onMessagePosted({
        messageId: `00000000-0000-0000-0000-00000000030${i}`,
        itemId,
        conversationId,
        attachmentCount: 1,
        hasTextBody: true,
        actorUserId: userIds.bob,
        actorExternalIdentityId: null,
      });
      await svc.markDone(itemId, userIds.alice);
    }
    let list = await svc.getListWithItems(listId, userIds.alice);
    expect(list.status).toBe('completed');
    await svc.requestRevision(itemIds[0]!, b64('reopen pls'), 1, userIds.alice);
    list = await svc.getListWithItems(listId, userIds.alice);
    expect(list.status).toBe('active');
    expect(list.completedAt).toBeNull();
  });

  it('rejects revision on archived list', async () => {
    const svc = await import('../services/requestsService.js');
    const { listId, itemIds } = await makeListWithItems();
    await svc.onMessagePosted({
      messageId: '00000000-0000-0000-0000-000000000040',
      itemId: itemIds[2]!,
      conversationId,
      attachmentCount: 0,
      hasTextBody: true,
      actorUserId: userIds.bob,
      actorExternalIdentityId: null,
    });
    await svc.updateList(listId, { status: 'archived' }, userIds.alice);
    await expect(
      svc.requestRevision(itemIds[2]!, b64('note'), 1, userIds.alice),
    ).rejects.toMatchObject({ code: 'bad_state' });
  });
});

describe('templates', () => {
  it('rejects duplicate active template names', async () => {
    const svc = await import('../services/requestsService.js');
    await svc.createTemplate(
      {
        name: 'Year-end',
        itemSpecs: [{ title: 'a', responseType: 'text', sortOrder: 0 }],
      },
      userIds.alice,
    );
    await expect(
      svc.createTemplate(
        {
          name: 'Year-end',
          itemSpecs: [{ title: 'b', responseType: 'text', sortOrder: 0 }],
        },
        userIds.alice,
      ),
    ).rejects.toMatchObject({ code: 'unique_violation' });
  });

  it('archiving frees the name for reuse', async () => {
    const svc = await import('../services/requestsService.js');
    const t1 = await svc.createTemplate(
      {
        name: 'Year-end',
        itemSpecs: [{ title: 'a', responseType: 'text', sortOrder: 0 }],
      },
      userIds.alice,
    );
    await svc.archiveTemplate(t1.id, userIds.alice);
    const t2 = await svc.createTemplate(
      {
        name: 'Year-end',
        itemSpecs: [{ title: 'b', responseType: 'text', sortOrder: 0 }],
      },
      userIds.alice,
    );
    expect(t2.id).not.toBe(t1.id);
  });
});
