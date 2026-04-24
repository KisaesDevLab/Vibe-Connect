/**
 * Targeted regression coverage for the CRITICAL findings from the
 * data/file-exposure audit:
 *
 *  C1. DELETE /conversations/messages/:id must reject removed ex-members
 *      (conversations.ts previously only checked sender_id, which let a user
 *      who was kicked from a conversation nuke their own prior messages).
 *
 *  C2. GET /portal/conversations/:id/messages must not return message
 *      metadata (timestamps, senderExternalIdentityId, source) to a client
 *      that hasn't satisfied step-up. Ciphertext alone is safe, but that
 *      metadata lets a credential-stealing attacker browse conversation
 *      rhythm before the legitimate user notices.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import type { Express } from 'express';
import type * as CryptoMod from '@vibe-connect/crypto';
import { resetTestDb } from './test-helpers.js';

let app: Express;
let crypto: typeof CryptoMod;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
  crypto = await import('@vibe-connect/crypto');
  await crypto.ready();
  const mod = await import('../app.js');
  app = mod.createApp();
}, 120_000);

async function loginAs(username: string, password: string) {
  const agent = request.agent(app);
  const r = await agent.post('/auth/login').send({ username, password });
  if (r.status !== 200) throw new Error(`login_${r.status}`);
  const me = await agent.get('/auth/me');
  return { agent, userId: me.body.user.id as string };
}

describe('C1: message DELETE blocks removed ex-members', () => {
  it('sender removed from a conversation cannot delete their own prior messages', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');

    // Minimal conversation setup: Kurt creates, both are members, wrapped keys
    // are unused for this test but required by the create schema.
    const kurtDevice = await crypto.enrollDevice({
      password: 'kurt-dev-only-ChangeMe!',
      deviceId: crypto.newDeviceId(),
      clientPlatform: 'web',
      clientVersion: '0.1.0',
    });
    const aliceDevice = await crypto.enrollDevice({
      password: 'alice-dev-only-ChangeMe!',
      deviceId: crypto.newDeviceId(),
      clientPlatform: 'web',
      clientVersion: '0.1.0',
    });
    const { bundle, wrappedKeys } = await crypto.createConversationKey([
      { id: `${kurt.userId}:k`, publicKey: kurtDevice.publicKey },
      { id: `${alice.userId}:a`, publicKey: aliceDevice.publicKey },
    ]);
    const created = await kurt.agent.post('/conversations').send({
      type: 'internal',
      memberUserIds: [kurt.userId, alice.userId],
      wrappedKeys,
      rotationVersion: bundle.rotationVersion,
    });
    expect(created.status).toBe(201);
    const convId = created.body.id as string;

    // Alice sends a message.
    const msgResp = await alice.agent.post(`/conversations/${convId}/messages`).send({
      ciphertext: Buffer.from('ignored-ciphertext').toString('base64'),
      contentKeyVersion: bundle.rotationVersion,
    });
    expect(msgResp.status).toBe(201);
    const messageId = msgResp.body.id as string;

    // Kurt (creator) removes Alice from the conversation. The endpoint is
    // DELETE /:id/members with a body — it requires rotated wrapped keys so
    // the remaining members get a fresh conversation key the ex-member never
    // saw. For this test any non-empty map is fine; we don't decrypt.
    const removed = await kurt.agent
      .delete(`/conversations/${convId}/members`)
      .send({
        userId: alice.userId,
        rotatedWrappedKeys: { [`${kurt.userId}:k`]: 'rotated-placeholder' },
        rotationVersion: bundle.rotationVersion + 1,
      });
    expect([200, 204]).toContain(removed.status);

    // Alice tries to delete her own prior message — must be refused because
    // she's no longer a member, even though she's still the sender.
    const deleteAttempt = await alice.agent.delete(`/conversations/messages/${messageId}`);
    expect(deleteAttempt.status).toBe(403);

    // Sanity check: the message still exists (not soft-deleted).
    const { db } = await import('../db/knex.js');
    const row = await db('messages').where({ id: messageId }).first();
    expect(row).toBeTruthy();
    expect(row.deleted_at).toBeNull();
  }, 60_000);
});

describe('C2: portal messages list withholds metadata when step-up required', () => {
  it('returns stepupRequired:true + empty messages when verified_until is stale', async () => {
    const { db } = await import('../db/knex.js');

    // Seed an external identity that REQUIRES step-up (has a last-4 hash +
    // verification_required=true) and put it in a brand-new conversation.
    const last4Hash = bcrypt.hashSync('1234', 10);
    const [identity] = await db('external_identities')
      .insert({
        email: `stepup-meta-${Date.now()}@example.com`,
        display_name: 'Metadata Tester',
        verification_type: 'ssn',
        verification_last4_hash: last4Hash,
        verification_required: true,
      })
      .returning(['id']);
    const [conv] = await db('conversations')
      .insert({ type: 'external', display_name: 'Stepup Metadata Test' })
      .returning(['id']);
    await db('conversation_members').insert({
      conversation_id: conv.id,
      external_identity_id: identity.id,
    });
    // Drop a message into the conversation so "withheld" is distinguishable
    // from "no messages exist at all".
    await db('messages').insert({
      conversation_id: conv.id,
      sender_id: null,
      sender_external_identity_id: identity.id,
      ciphertext: Buffer.from('opaque'),
      content_key_version: 1,
      source: 'email-in',
    });

    // Manually issue a portal session WITHOUT verified_until so stepup fires.
    const { newSessionToken, hashSessionToken } = await import('../services/accessCodes.js');
    const token = newSessionToken();
    await db('client_sessions').insert({
      external_identity_id: identity.id,
      session_token_hash: hashSessionToken(token),
      absolute_expires_at: new Date(Date.now() + 60 * 60 * 1000),
      user_agent: 'test',
      ip_address: '127.0.0.1',
      session_public_key: 'test-pubkey',
    });

    const agent = request.agent(app);
    const resp = await agent
      .get(`/portal/conversations/${conv.id}/messages`)
      .set('Cookie', `vibe.portal=${token}`);
    expect(resp.status).toBe(200);
    expect(resp.body.stepupRequired).toBe(true);
    expect(resp.body.messages).toEqual([]);
    // Belt-and-suspenders: no ciphertext, no timestamps, no sender IDs leak.
    expect(JSON.stringify(resp.body)).not.toContain('email-in');
  }, 60_000);

  it('returns full message payloads once verified_until is in the future', async () => {
    const { db } = await import('../db/knex.js');
    const last4Hash = bcrypt.hashSync('1234', 10);
    const [identity] = await db('external_identities')
      .insert({
        email: `stepup-ok-${Date.now()}@example.com`,
        display_name: 'Verified Tester',
        verification_type: 'ssn',
        verification_last4_hash: last4Hash,
        verification_required: true,
      })
      .returning(['id']);
    const [conv] = await db('conversations')
      .insert({ type: 'external', display_name: 'Stepup Verified Test' })
      .returning(['id']);
    await db('conversation_members').insert({
      conversation_id: conv.id,
      external_identity_id: identity.id,
    });
    await db('messages').insert({
      conversation_id: conv.id,
      sender_id: null,
      sender_external_identity_id: identity.id,
      ciphertext: Buffer.from('opaque'),
      content_key_version: 1,
      source: 'app',
    });
    const { newSessionToken, hashSessionToken } = await import('../services/accessCodes.js');
    const token = newSessionToken();
    await db('client_sessions').insert({
      external_identity_id: identity.id,
      session_token_hash: hashSessionToken(token),
      absolute_expires_at: new Date(Date.now() + 60 * 60 * 1000),
      verified_until: new Date(Date.now() + 60 * 60 * 1000),
      user_agent: 'test',
      ip_address: '127.0.0.1',
      session_public_key: 'test-pubkey',
    });
    const agent = request.agent(app);
    const resp = await agent
      .get(`/portal/conversations/${conv.id}/messages`)
      .set('Cookie', `vibe.portal=${token}`);
    expect(resp.status).toBe(200);
    expect(resp.body.stepupRequired).toBeUndefined();
    expect(resp.body.messages).toHaveLength(1);
    expect(resp.body.messages[0].source).toBe('app');
  }, 60_000);
});
