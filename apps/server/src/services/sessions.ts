// Helpers for invalidating express-session rows held in the `session` table by
// `connect-pg-simple`. Sessions store their JSON payload in `sess`; we match on
// `sess->>'userId'` to target a specific staff user.
//
// Call this whenever trust in a user's live sessions must be broken:
//   - password reset
//   - user deactivation
//   - admin device revoke (terminates sessions for the device's owner)
//
// Staff clients observing `device:revoked` realtime events will also self-wipe IDB
// and redirect to /login, but server-side termination is the authoritative cut —
// it stops anyone holding the session cookie, regardless of live socket state.

import { db } from '../db/knex.js';

/** Delete all persisted sessions for the given user. Returns count deleted. */
export async function terminateSessionsForUser(userId: string): Promise<number> {
  const rows = await db('session')
    .whereRaw(`sess->>'userId' = ?`, [userId])
    .del();
  return rows;
}
