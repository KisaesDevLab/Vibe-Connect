// Presence tracking: socket_count + last_heartbeat_at per user.
import { db } from '../db/knex.js';

export const presenceRepo = {
  async connect(userId: string): Promise<void> {
    await db.raw(
      `
      INSERT INTO user_presence (user_id, socket_count, last_heartbeat_at)
      VALUES (?, 1, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET socket_count = user_presence.socket_count + 1,
            last_heartbeat_at = NOW()
      `,
      [userId],
    );
    await db('users').where({ id: userId }).update({ status: 'active', last_seen_at: db.fn.now() });
  },
  async disconnect(userId: string): Promise<number> {
    const res = await db.raw<{ rows: { socket_count: number }[] }>(
      `
      UPDATE user_presence
      SET socket_count = GREATEST(0, socket_count - 1),
          last_heartbeat_at = NOW()
      WHERE user_id = ?
      RETURNING socket_count
      `,
      [userId],
    );
    const remaining = Number(res.rows[0]?.socket_count ?? 0);
    if (remaining === 0) {
      await db('users')
        .where({ id: userId })
        .update({ status: 'offline', last_seen_at: db.fn.now() });
    }
    return remaining;
  },
  async heartbeat(userId: string): Promise<void> {
    await db('user_presence').where({ user_id: userId }).update({ last_heartbeat_at: db.fn.now() });
  },
  async snapshot() {
    return db('user_presence').select('*');
  },
};
