import type { UserStatus, ClientPlatform } from '@vibe-connect/shared-types';
import { db } from '../db/knex.js';

export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  phone: string | null;
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
  findByEmail(email: string) {
    return db<UserRow>('users').whereRaw('LOWER(email) = ?', [email.toLowerCase()]).first();
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
  findDeviceKey(userId: string, deviceId: string) {
    return db<DeviceKeyRow>('user_keys').where({ user_id: userId, device_id: deviceId }).first();
  },
  listDeviceKeys(userId: string) {
    return db<DeviceKeyRow>('user_keys').where({ user_id: userId }).orderBy('created_at', 'desc');
  },
  listActiveDeviceKeysForUsers(userIds: string[]) {
    return db<DeviceKeyRow>('user_keys')
      .whereIn('user_id', userIds)
      .whereNull('revoked_at')
      .orderBy('user_id')
      .orderBy('created_at');
  },
  async insertDeviceKey(
    row: Omit<
      DeviceKeyRow,
      'id' | 'key_version' | 'last_heartbeat_at' | 'created_at' | 'revoked_at'
    >,
  ): Promise<DeviceKeyRow> {
    const [created] = await db<DeviceKeyRow>('user_keys')
      .insert(row as never)
      .returning('*');
    return created!;
  },
  async updateDeviceKey(
    id: string,
    patch: Partial<Omit<DeviceKeyRow, 'id' | 'user_id' | 'device_id' | 'created_at'>>,
  ) {
    await db('user_keys')
      .where({ id })
      .update(patch as never);
  },
};

export interface DeviceKeyRow {
  id: string;
  user_id: string;
  device_id: string;
  public_key: string;
  encrypted_private_key: string;
  kdf_params: { opsLimit: number; memLimit: number; algorithm: 'argon2id13' };
  kdf_salt: string;
  key_version: number;
  client_platform: ClientPlatform;
  client_version: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  revoked_at: string | null;
}
