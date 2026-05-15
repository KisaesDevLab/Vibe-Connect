/**
 * Phase 28.3 — Public staff-listing endpoint.
 *
 * The /api/public/intake/staff response is what walk-up clients see on the
 * anonymous /intake landing. Tests focus on three load-bearing properties:
 *   - Anonymous access works (no requireAuth interception by requestsRouter
 *     or any other blanket-auth router).
 *   - Projection is locked — only six fields ever leave the server; email,
 *     phone, role, last-seen, and similar internal columns must not appear.
 *     Adding an entry here on accident is the realistic regression path
 *     (someone adds a SELECT column at the repo layer without re-reading
 *     this comment).
 *   - Cache TTL behaviour — within a TTL, mutations don't surface; after
 *     invalidation they do.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { db } from '../db/knex.js';
import { resetTestDb } from './test-helpers.js';
import { __resetIntakeStaffCache } from '../routes/intakePublic.js';

let app: Express;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
  const mod = await import('../app.js');
  app = mod.createApp();
});

beforeEach(() => {
  __resetIntakeStaffCache();
});

describe('GET /api/public/intake/staff', () => {
  it('is reachable anonymously (no requireAuth intercept)', async () => {
    const r = await request(app).get('/api/public/intake/staff');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('staff');
    expect(Array.isArray(r.body.staff)).toBe(true);
  });

  it('returns only opted-in, active staff', async () => {
    // Seed: opt alice in, leave the others as they are. Then assert alice
    // is present and the result includes only opted-in rows.
    await db('users')
      .where({ username: 'alice' })
      .update({ show_on_intake_card: true, intake_card_title: 'Payroll lead' });
    __resetIntakeStaffCache();

    const r = await request(app).get('/api/public/intake/staff');
    expect(r.status).toBe(200);
    const names: string[] = r.body.staff.map((s: { display_name: string }) => s.display_name);
    expect(names.some((n) => n.toLowerCase().includes('alice'))).toBe(true);
    // Sanity: nothing in the list is opted out. We can verify by id —
    // every returned id should have show_on_intake_card=true in the DB.
    const ids = r.body.staff.map((s: { id: string }) => s.id);
    const optedRows = await db('users')
      .whereIn('id', ids)
      .pluck('show_on_intake_card');
    for (const v of optedRows) expect(v).toBe(true);
  });

  it('excludes deactivated users even if show_on_intake_card=true', async () => {
    // Belt-and-suspenders: a user deactivated by an admin should disappear
    // from the public listing immediately (subject to cache TTL — we bust
    // it manually). Otherwise a fired employee's card would keep accepting
    // intakes until the admin remembers to flip the toggle.
    await db('users').where({ username: 'bob' }).update({
      show_on_intake_card: true,
      is_active: false,
    });
    __resetIntakeStaffCache();
    const r = await request(app).get('/api/public/intake/staff');
    expect(r.status).toBe(200);
    const names: string[] = r.body.staff.map((s: { display_name: string }) => s.display_name);
    expect(names.some((n) => n.toLowerCase().includes('bob'))).toBe(false);
    // Restore for other tests in this file.
    await db('users').where({ username: 'bob' }).update({ is_active: true });
  });

  it('projection contains exactly the six allowed fields — never internal columns', async () => {
    await db('users').where({ username: 'alice' }).update({ show_on_intake_card: true });
    __resetIntakeStaffCache();
    const r = await request(app).get('/api/public/intake/staff');
    expect(r.status).toBe(200);
    const allowed = new Set(['id', 'display_name', 'title', 'bio', 'headshot_url', 'order']);
    for (const row of r.body.staff) {
      const keys = Object.keys(row);
      for (const k of keys) {
        expect(allowed.has(k), `unexpected field "${k}" in public staff projection`).toBe(true);
      }
      // Explicit deny-list — these would be the realistic regression paths.
      expect(row).not.toHaveProperty('email');
      expect(row).not.toHaveProperty('phone');
      expect(row).not.toHaveProperty('is_admin');
      expect(row).not.toHaveProperty('isAdmin');
      expect(row).not.toHaveProperty('username');
      expect(row).not.toHaveProperty('last_seen_at');
      expect(row).not.toHaveProperty('lastSeenAt');
      expect(row).not.toHaveProperty('status');
    }
  });

  it('sorts by intake_card_order NULLS LAST, then display_name ASC', async () => {
    // Set explicit order on alice (rank 0) and carol (rank 1). Bob keeps
    // null which should land *after* both per the ORDER BY.
    await db('users')
      .where({ username: 'alice' })
      .update({ show_on_intake_card: true, intake_card_order: 0 });
    await db('users')
      .where({ username: 'carol' })
      .update({ show_on_intake_card: true, intake_card_order: 1 });
    await db('users')
      .where({ username: 'bob' })
      .update({ show_on_intake_card: true, intake_card_order: null });
    __resetIntakeStaffCache();

    const r = await request(app).get('/api/public/intake/staff');
    const orderedIds: string[] = r.body.staff.map((s: { id: string }) => s.id);
    const userRows = await db('users')
      .whereIn('username', ['alice', 'bob', 'carol'])
      .select('id', 'username');
    const byUsername = Object.fromEntries(userRows.map((u) => [u.username, u.id]));
    // alice (0) before carol (1) before bob (null) — both alice and carol
    // come before bob because NULLs sort last per the publicListing query.
    expect(orderedIds.indexOf(byUsername.alice)).toBeLessThan(orderedIds.indexOf(byUsername.carol));
    expect(orderedIds.indexOf(byUsername.carol)).toBeLessThan(orderedIds.indexOf(byUsername.bob));
  });

  it('sets a 60s Cache-Control header on responses', async () => {
    const r = await request(app).get('/api/public/intake/staff');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toMatch(/max-age=60/);
  });

  it('caches results in-process until TTL expires (verified by __resetIntakeStaffCache)', async () => {
    await db('users').where({ username: 'alice' }).update({ show_on_intake_card: true });
    __resetIntakeStaffCache();
    const r1 = await request(app).get('/api/public/intake/staff');
    const namesBefore: string[] = r1.body.staff.map((s: { display_name: string }) => s.display_name);
    expect(namesBefore.some((n) => n.toLowerCase().includes('alice'))).toBe(true);

    // Flip alice OFF, hit the endpoint again — should still show alice
    // because the in-memory cache holds the previous list.
    await db('users').where({ username: 'alice' }).update({ show_on_intake_card: false });
    const r2 = await request(app).get('/api/public/intake/staff');
    const namesCached: string[] = r2.body.staff.map((s: { display_name: string }) => s.display_name);
    expect(namesCached.some((n) => n.toLowerCase().includes('alice'))).toBe(true);

    // Bust the cache → next read reflects the new state.
    __resetIntakeStaffCache();
    const r3 = await request(app).get('/api/public/intake/staff');
    const namesAfter: string[] = r3.body.staff.map((s: { display_name: string }) => s.display_name);
    expect(namesAfter.some((n) => n.toLowerCase().includes('alice'))).toBe(false);
  });
});
