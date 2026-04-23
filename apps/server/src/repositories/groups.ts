import { db } from '../db/knex.js';

export interface GroupRow {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
}

export const groupsRepo = {
  all() {
    return db<GroupRow>('groups').orderBy('sort_order').orderBy('name');
  },
  byId(id: string) {
    return db<GroupRow>('groups').where({ id }).first();
  },
  async create(name: string, sortOrder: number) {
    const [row] = await db<GroupRow>('groups')
      .insert({ name, sort_order: sortOrder })
      .returning('*');
    return row!;
  },
  async rename(id: string, name: string) {
    const [row] = await db<GroupRow>('groups').where({ id }).update({ name }).returning('*');
    return row;
  },
  async reorder(updates: { id: string; sortOrder: number }[]) {
    await db.transaction(async (trx) => {
      for (const u of updates) {
        await trx('groups').where({ id: u.id }).update({ sort_order: u.sortOrder });
      }
    });
  },
  async remove(id: string) {
    await db('groups').where({ id }).del();
  },
  async addMember(groupId: string, userId: string) {
    await db('user_groups')
      .insert({ group_id: groupId, user_id: userId })
      .onConflict(['user_id', 'group_id'])
      .ignore();
  },
  async removeMember(groupId: string, userId: string) {
    await db('user_groups').where({ group_id: groupId, user_id: userId }).del();
  },
  async membersByGroup(): Promise<Record<string, string[]>> {
    const rows = await db('user_groups').select<{ group_id: string; user_id: string }[]>(
      'group_id',
      'user_id',
    );
    const out: Record<string, string[]> = {};
    for (const r of rows) {
      const arr = out[r.group_id] ?? (out[r.group_id] = []);
      arr.push(r.user_id);
    }
    return out;
  },
};
