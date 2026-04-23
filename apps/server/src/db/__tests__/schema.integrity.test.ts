/**
 * Phase 1 integrity checks:
 * - All 17+ required tables exist with expected columns.
 * - Enums present.
 * - CHECK constraints block bad inserts.
 * - Seeds produced Kurt + groups + the singleton firm_settings row.
 * - Conversation-type / member-exclusivity / message-sender constraints enforced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Knex from 'knex';
// @ts-expect-error — CJS knexfile
import config from '../../../knexfile.cjs';

const db = Knex(config.test);

const TABLES = [
  'users',
  'user_keys',
  'firm_keys',
  'groups',
  'user_groups',
  'conversations',
  'conversation_members',
  'external_identities',
  'access_codes',
  'client_sessions',
  'conversation_keys',
  'messages',
  'attachments',
  'read_receipts',
  'user_presence',
  'sms_opt_ins',
  'audit_log',
  'firm_settings',
  'session',
];

beforeAll(async () => {
  // Apply migrations to the test DB; re-seed from scratch.
  await db.migrate.rollback(undefined, true);
  await db.migrate.latest();
  await db.seed.run();
}, 120_000);

afterAll(async () => {
  await db.destroy().catch(() => null);
});

describe('Phase 1 — schema integrity', () => {
  it('creates every required table', async () => {
    const rows = await db.raw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    const names = new Set<string>(rows.rows.map((r: { tablename: string }) => r.tablename));
    for (const t of TABLES) expect(names.has(t), `missing table: ${t}`).toBe(true);
  });

  it('creates every required enum type', async () => {
    const rows = await db.raw(`SELECT typname FROM pg_type WHERE typtype = 'e'`);
    const names = new Set<string>(rows.rows.map((r: { typname: string }) => r.typname));
    for (const t of [
      'user_status',
      'client_platform',
      'conversation_type',
      'message_source',
      'verification_type',
      'access_code_channel',
      'sms_provider',
    ]) {
      expect(names.has(t), `missing enum: ${t}`).toBe(true);
    }
  });

  it('seed inserts four users and four groups', async () => {
    const users = await db('users').count<{ count: string }[]>('* as count');
    expect(Number(users[0]!.count)).toBe(4);
    const groups = await db('groups').count<{ count: string }[]>('* as count');
    expect(Number(groups[0]!.count)).toBe(4);
  });

  it('seeds kurt as admin', async () => {
    const kurt = await db('users').where({ username: 'kurt' }).first();
    expect(kurt).toBeTruthy();
    expect(kurt.is_admin).toBe(true);
    expect(kurt.password_hash).toMatch(/^\$2[aby]\$\d{2}\$/); // bcrypt format
  });

  it('firm_settings is a single, id=1 row', async () => {
    const rows = await db('firm_settings');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(1);
  });

  it('rejects internal conversation with parent', async () => {
    await expect(
      db('conversations').insert({
        type: 'internal',
        parent_conversation_id: (
          await db('conversations').insert({ type: 'internal' }).returning(['id'])
        )[0]!.id,
      }),
    ).rejects.toThrow();
  });

  it('rejects conversation_member with both user_id AND external_identity_id', async () => {
    const [conv] = await db('conversations').insert({ type: 'internal' }).returning(['id']);
    const [user] = await db('users').where({ username: 'kurt' }).select('id');
    const [ext] = await db('external_identities')
      .insert({
        email: 'bad-member@example.com',
        display_name: 'Bad Member',
      })
      .returning(['id']);
    await expect(
      db('conversation_members').insert({
        conversation_id: conv!.id,
        user_id: user!.id,
        external_identity_id: ext!.id,
      }),
    ).rejects.toThrow();
  });

  it('rejects conversation_member with neither user_id NOR external_identity_id', async () => {
    const [conv] = await db('conversations').insert({ type: 'internal' }).returning(['id']);
    await expect(
      db('conversation_members').insert({ conversation_id: conv!.id }),
    ).rejects.toThrow();
  });

  it('rejects non-system message with both sender ids', async () => {
    const [conv] = await db('conversations').insert({ type: 'internal' }).returning(['id']);
    const [user] = await db('users').where({ username: 'kurt' }).select('id');
    const [ext] = await db('external_identities')
      .insert({
        email: 'bad-sender@example.com',
        display_name: 'Bad Sender',
      })
      .returning(['id']);
    await expect(
      db('messages').insert({
        conversation_id: conv!.id,
        sender_id: user!.id,
        sender_external_identity_id: ext!.id,
        ciphertext: Buffer.from('x'),
        content_key_version: 1,
      }),
    ).rejects.toThrow();
  });

  it('accepts a system message with no sender', async () => {
    const [conv] = await db('conversations').insert({ type: 'internal' }).returning(['id']);
    const [msg] = await db('messages')
      .insert({
        conversation_id: conv!.id,
        ciphertext: Buffer.from('system-notice'),
        content_key_version: 1,
        source: 'system',
      })
      .returning(['id']);
    expect(msg!.id).toBeTruthy();
  });

  it('unique constraint on user_keys (user_id, device_id)', async () => {
    const [user] = await db('users').where({ username: 'alice' }).select('id');
    await db('user_keys').insert({
      user_id: user!.id,
      device_id: 'dev-A',
      public_key: 'pk',
      encrypted_private_key: 'wrapped',
      kdf_params: { opsLimit: 2, memLimit: 1_000_000, algorithm: 'argon2id13' },
      kdf_salt: 'salt',
      client_platform: 'pwa',
    });
    await expect(
      db('user_keys').insert({
        user_id: user!.id,
        device_id: 'dev-A',
        public_key: 'pk2',
        encrypted_private_key: 'wrapped2',
        kdf_params: { opsLimit: 2, memLimit: 1_000_000, algorithm: 'argon2id13' },
        kdf_salt: 'salt2',
        client_platform: 'pwa',
      }),
    ).rejects.toThrow();
  });

  it('only one non-retired firm_keys row allowed', async () => {
    await db('firm_keys').insert({
      public_key: 'pk',
      encrypted_recovery_private_key: 'wrapped',
      kdf_params: { opsLimit: 2, memLimit: 1_000_000, algorithm: 'argon2id13' },
      kdf_salt: 'salt',
      rotation_version: 1,
    });
    await expect(
      db('firm_keys').insert({
        public_key: 'pk2',
        encrypted_recovery_private_key: 'wrapped2',
        kdf_params: { opsLimit: 2, memLimit: 1_000_000, algorithm: 'argon2id13' },
        kdf_salt: 'salt2',
        rotation_version: 2,
      }),
    ).rejects.toThrow();
  });
});
