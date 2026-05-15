/**
 * Phase 28.2 — Staff intake-card settings.
 *
 * Covers GET/PATCH/POST on `/users/me/intake-card`, the admin reorder + list
 * endpoints, the empty-state status endpoint, and the public headshot
 * serving route. Audit emission is verified end-to-end against the existing
 * `audit_log` table — no per-feature audit table, per the Phase 28 stack
 * remap (CLAUDE.md "Phase 28 deliberate exception").
 *
 * Fixtures: the seed creates `kurt` (admin) and `alice` (non-admin staff).
 * We always login through /auth/login rather than poking session state
 * directly so the route-level requireAuth + requireAdmin guards run.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import sharp from 'sharp';
import { db } from '../db/knex.js';
import { resetTestDb } from './test-helpers.js';

let app: Express;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
  const mod = await import('../app.js');
  app = mod.createApp();
});

type TestAgent = ReturnType<typeof request.agent>;
async function loginAs(username: string, password: string): Promise<TestAgent> {
  const agent = request.agent(app);
  const res = await agent.post('/auth/login').send({ username, password });
  if (res.status !== 200) {
    throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return agent;
}

/** Build an in-memory PNG. Sharp accepts a raw pixel buffer with metadata
 *  or any common encoded image — we use a coloured square so the resize
 *  step has something deterministic to crop. */
async function makePng(width: number, height: number, hex = '#3366aa'): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: hex },
  })
    .png()
    .toBuffer();
}

describe('Phase 28.2 — GET/PATCH /users/me/intake-card', () => {
  it('requires auth', async () => {
    const r = await request(app).get('/users/me/intake-card');
    expect(r.status).toBe(401);
  });

  it('returns default-shape card for a fresh staff user', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await agent.get('/users/me/intake-card');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      showOnIntakeCard: expect.any(Boolean),
      bio: null,
      title: null,
      headshotUrl: null,
      order: null,
      // Phase 28.12 (QA-followup): per-staff notification preference,
      // default 'realtime' per migration 20260515000001.
      notifyMode: 'realtime',
    });
  });

  it('PATCH updates self toggle + bio + title and emits intake.card.updated', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const beforeAudit = await db('audit_log').where({ action: 'intake.card.updated' }).count();
    const r = await agent.patch('/users/me/intake-card').send({
      showOnIntakeCard: true,
      bio: 'Senior Tax Manager. Loves long walks on PE returns.',
      title: 'Senior Tax Manager',
    });
    expect(r.status).toBe(200);
    expect(r.body.showOnIntakeCard).toBe(true);
    expect(r.body.bio).toContain('Senior Tax');
    expect(r.body.title).toBe('Senior Tax Manager');
    const afterAudit = await db('audit_log').where({ action: 'intake.card.updated' }).count();
    expect(Number(afterAudit[0]!.count)).toBe(Number(beforeAudit[0]!.count) + 1);
  });

  it('PATCH rejects bio above 280 chars server-side', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await agent.patch('/users/me/intake-card').send({ bio: 'x'.repeat(281) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_request');
  });

  it('PATCH rejects title above 60 chars server-side', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await agent.patch('/users/me/intake-card').send({ title: 'x'.repeat(61) });
    expect(r.status).toBe(400);
  });

  it('PATCH does not allow callers to change other users by smuggling user_id', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    // The schema is .strict() — unknown keys (e.g. userId, intake_card_order)
    // fail validation rather than silently being ignored.
    const r = await agent
      .patch('/users/me/intake-card')
      .send({ title: 'x', intake_card_order: 999 });
    expect(r.status).toBe(400);
  });

  it('PATCH accepts null to clear bio/title', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    await agent.patch('/users/me/intake-card').send({ title: 'temp' });
    const r = await agent.patch('/users/me/intake-card').send({ title: null });
    expect(r.status).toBe(200);
    expect(r.body.title).toBeNull();
  });

  it('empty PATCH body does NOT emit an audit row', async () => {
    // A no-op PATCH (no fields supplied after strict-parse) should return
    // 200 with the current card state but NOT write to audit_log —
    // audit rows are for changes, not idempotent reads-through-PATCH.
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const beforeAudit = await db('audit_log').where({ action: 'intake.card.updated' }).count();
    const r = await agent.patch('/users/me/intake-card').send({});
    expect(r.status).toBe(200);
    const afterAudit = await db('audit_log').where({ action: 'intake.card.updated' }).count();
    expect(Number(afterAudit[0]!.count)).toBe(Number(beforeAudit[0]!.count));
  });
});

describe('Phase 28.2 — POST /users/me/intake-card/headshot', () => {
  it('requires auth', async () => {
    const r = await request(app)
      .post('/users/me/intake-card/headshot')
      .attach('headshot', await makePng(100, 100), 'face.png');
    expect(r.status).toBe(401);
  });

  it('uploads a PNG, resizes to 400x400 webp, encrypts at rest, serves from disk', async () => {
    const agent = await loginAs('carol', 'carol-dev-only-ChangeMe!');
    const png = await makePng(800, 600);
    const beforeAudit = await db('audit_log')
      .where({ action: 'intake.card.headshot_updated' })
      .count();
    const r = await agent
      .post('/users/me/intake-card/headshot')
      .attach('headshot', png, { filename: 'face.png', contentType: 'image/png' });
    expect(r.status).toBe(200);
    expect(r.body.headshotUrl).toMatch(/^\/attachments\/intake-headshots\/.+\.webp\.enc$/);

    // The public serve route returns the decrypted webp — no auth.
    const fetched = await request(app).get(r.body.headshotUrl as string);
    expect(fetched.status).toBe(200);
    expect(fetched.headers['content-type']).toBe('image/webp');
    expect(fetched.headers['x-content-type-options']).toBe('nosniff');

    // sharp::metadata round-trip verifies the served bytes are a real 400×400
    // webp, not just a body the route slapped a webp content-type onto.
    const meta = await sharp(fetched.body as Buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(400);

    // Audit row exists, AND its details JSONB carries only the byte count —
    // never the filename (would leak the predictable `${userId}.webp.enc`
    // form even though the userId is already the targetId). Phase 28
    // build plan: "audit payloads must not include plaintext PII".
    const auditRow = await db('audit_log')
      .where({ action: 'intake.card.headshot_updated' })
      .orderBy('created_at', 'desc')
      .first();
    expect(auditRow).toBeDefined();
    const details = auditRow!.details as Record<string, unknown>;
    expect(details).toHaveProperty('bytes');
    expect(details).not.toHaveProperty('filename');
    expect(details).not.toHaveProperty('storedPath');
    expect(details).not.toHaveProperty('headshotUrl');
    const afterAudit = await db('audit_log')
      .where({ action: 'intake.card.headshot_updated' })
      .count();
    expect(Number(afterAudit[0]!.count)).toBe(Number(beforeAudit[0]!.count) + 1);
  });

  it('rejects an oversized image (limitInputPixels image-bomb guard)', async () => {
    // 6000×5000 = 30 MP, above the 25 MP cap we set on sharp(). The encoded
    // PNG of a solid colour is only a few hundred KB so multer's 5 MB cap
    // doesn't fire — sharp's own pixel-count guard is what protects us.
    const agent = await loginAs('carol', 'carol-dev-only-ChangeMe!');
    const png = await makePng(6000, 5000);
    const r = await agent
      .post('/users/me/intake-card/headshot')
      .attach('headshot', png, { filename: 'bomb.png', contentType: 'image/png' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('image_decode_failed');
  });

  it('rejects non-image MIME type', async () => {
    const agent = await loginAs('carol', 'carol-dev-only-ChangeMe!');
    const r = await agent
      .post('/users/me/intake-card/headshot')
      .attach('headshot', Buffer.from('not an image'), {
        filename: 'a.txt',
        contentType: 'text/plain',
      });
    // multer's fileFilter drops the file silently — the route then returns
    // no_file because req.file is undefined.
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('no_file');
  });

  it('rejects spoofed MIME with non-image bytes', async () => {
    const agent = await loginAs('carol', 'carol-dev-only-ChangeMe!');
    const r = await agent
      .post('/users/me/intake-card/headshot')
      .attach('headshot', Buffer.from('not actually a png'), {
        filename: 'a.png',
        contentType: 'image/png',
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('image_decode_failed');
  });

  it('public serve route rejects malformed filenames', async () => {
    // Express collapses `..` segments BEFORE route matching, so the path
    // `/attachments/intake-headshots/../../etc/passwd` becomes `/etc/passwd`
    // which doesn't match this handler at all. Whatever picks it up (or no
    // handler — 404) is fine; the point is the headshot serve does not
    // read outside its directory. Accept any non-200, non-500 status.
    const r1 = await request(app).get('/attachments/intake-headshots/../../etc/passwd');
    expect(r1.status).toBeGreaterThanOrEqual(400);
    expect(r1.status).toBeLessThan(500);
    expect(r1.headers['content-type'] ?? '').not.toContain('image');

    const r2 = await request(app).get('/attachments/intake-headshots/not-a-uuid.webp.enc');
    expect(r2.status).toBe(400);
  });

  it('public serve route returns 404 for an unknown headshot id', async () => {
    const fakeUuid = '00000000-0000-0000-0000-000000000000';
    const r = await request(app).get(`/attachments/intake-headshots/${fakeUuid}.webp.enc`);
    expect(r.status).toBe(404);
  });
});

describe('Phase 28.2 — admin intake-cards', () => {
  it('GET /admin/intake-cards requires admin', async () => {
    const aliceAgent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await aliceAgent.get('/admin/intake-cards');
    expect(r.status).toBe(403);
  });

  it('GET /admin/intake-cards returns all active staff for admins', async () => {
    const kurtAgent = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurtAgent.get('/admin/intake-cards');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.cards)).toBe(true);
    expect(r.body.cards.length).toBeGreaterThanOrEqual(2);
    const kurtRow = r.body.cards.find(
      (c: { displayName: string }) => c.displayName.toLowerCase().includes('kurt'),
    );
    expect(kurtRow).toBeDefined();
    expect(typeof kurtRow.isAdmin).toBe('boolean');
    expect(typeof kurtRow.showOnIntakeCard).toBe('boolean');
    // `order` is nullable per the schema — null means "alphabetical
    // fallback ordering"; integer means "explicit position". Either is valid
    // on a fresh seed.
    expect(kurtRow.order === null || typeof kurtRow.order === 'number').toBe(true);
  });

  it('POST /admin/intake-cards/reorder requires admin and writes the order', async () => {
    const aliceAgent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const denied = await aliceAgent
      .post('/admin/intake-cards/reorder')
      .send({ items: [] });
    expect(denied.status).toBe(403);

    const kurtAgent = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const list = await kurtAgent.get('/admin/intake-cards');
    const someoneId = list.body.cards[0].userId as string;
    const beforeAudit = await db('audit_log')
      .where({ action: 'intake.card.order_changed' })
      .count();

    const r = await kurtAgent
      .post('/admin/intake-cards/reorder')
      .send({ items: [{ userId: someoneId, order: 42 }] });
    expect(r.status).toBe(200);
    expect(r.body.touched).toBe(1);

    const verify = await db('users').where({ id: someoneId }).first('intake_card_order');
    expect(verify.intake_card_order).toBe(42);

    const afterAudit = await db('audit_log').where({ action: 'intake.card.order_changed' }).count();
    expect(Number(afterAudit[0]!.count)).toBe(Number(beforeAudit[0]!.count) + 1);
  });

  it('reorder rejects malformed items (non-uuid, out-of-range order)', async () => {
    const kurtAgent = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r1 = await kurtAgent
      .post('/admin/intake-cards/reorder')
      .send({ items: [{ userId: 'not-a-uuid', order: 1 }] });
    expect(r1.status).toBe(400);
    const r2 = await kurtAgent
      .post('/admin/intake-cards/reorder')
      .send({ items: [{ userId: '00000000-0000-0000-0000-000000000000', order: -1 }] });
    expect(r2.status).toBe(400);
  });

  it('reorder rejects unknown / inactive user ids with the missing list', async () => {
    // Well-formed schema (real UUIDs) but the target user does not exist.
    // Repo throws ReorderUnknownUsersError, route surfaces 400 with the
    // missing list so the admin UI can prune the stale ids and retry.
    const kurtAgent = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const ghost = '11111111-2222-3333-4444-555555555555';
    const r = await kurtAgent
      .post('/admin/intake-cards/reorder')
      .send({ items: [{ userId: ghost, order: 5 }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('unknown_or_inactive_users');
    expect(r.body.missing).toEqual([ghost]);
  });

  it('GET /admin/intake/status reports opted-in count + configured flag', async () => {
    const kurtAgent = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurtAgent.get('/admin/intake/status');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      optedIn: expect.any(Number),
      configured: expect.any(Boolean),
    });
    expect(r.body.configured).toBe(r.body.optedIn > 0);
  });
});
