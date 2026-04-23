import type { UserStatus, ClientPlatform } from '@vibe-connect/shared-types';
import { db } from '../db/knex.js';

export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  password_hash: string;
  display_name: string;
  avatar_url: string | null;
  is_admin: boolean;
  is_active: boolean;
  status: UserStatus;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateUserInput {
  username: string;
  email?: string | null;
  passwordHash: string;
  displayName: string;
  isAdmin?: boolean;
  isActive?: boolean;
}

export const usersRepo = {
  findByUsername(username: string) {
    return db<UserRow>('users').where({ username }).first();
  },
  findById(id: string) {
    return db<UserRow>('users').where({ id }).first();
  },
  findAllActive() {
    return db<UserRow>('users').where({ is_active: true }).orderBy('display_name');
  },
  findAll() {
    return db<UserRow>('users').orderBy('display_name');
  },
  async create(input: CreateUserInput): Promise<UserRow> {
    const [row] = await db<UserRow>('users')
      .insert({
        username: input.username,
        email: input.email ?? null,
        password_hash: input.passwordHash,
        display_name: input.displayName,
        is_admin: input.isAdmin ?? false,
        is_active: input.isActive ?? true,
      })
      .returning('*');
    await db('user_presence').insert({ user_id: row!.id }).onConflict('user_id').ignore();
    return row!;
  },
  async update(id: string, patch: Partial<Omit<UserRow, 'id' | 'created_at'>>) {
    const [row] = await db<UserRow>('users')
      .where({ id })
      .update({ ...patch, updated_at: db.fn.now() })
      .returning('*');
    return row;
  },
  async setPassword(id: string, passwordHash: string) {
    await db('users')
      .where({ id })
      .update({ password_hash: passwordHash, updated_at: db.fn.now() });
  },
  async deactivate(id: string) {
    await db('users').where({ id }).update({ is_active: false, updated_at: db.fn.now() });
  },
  async reactivate(id: string) {
    await db('users').where({ id }).update({ is_active: true, updated_at: db.fn.now() });
  },
  async setStatus(id: string, status: UserStatus) {
    await db('users')
      .where({ id })
      .update({ status, last_seen_at: db.fn.now(), updated_at: db.fn.now() });
  },
  async touchHeartbeat(
    userId: string,
    deviceId: string,
    meta: {
      clientPlatform: ClientPlatform;
      clientVersion: string;
    },
  ) {
    await db('user_keys').where({ user_id: userId, device_id: deviceId }).update({
      last_heartbeat_at: db.fn.now(),
      client_platform: meta.clientPlatform,
      client_version: meta.clientVersion,
    });
  },
};
