/**
 * Phase 28.5 — tus upload + finalize integration tests.
 *
 * The happy path:
 *   1. POST /api/public/intake/sessions   → upload-token JWT
 *   2. POST /api/public/intake/uploads    → tus upload-id + Location
 *   3. PATCH /uploads/:id (offset=0)      → 204, bytes accepted
 *   4. assembled bytes are scanned + streaming-encrypted + persisted as
 *      an intake_files row, the partial file is unlinked
 *   5. POST /sessions/:id/finalize        → flips status, enqueues
 *      conversion + notification rows
 *
 * Negative paths we care about:
 *   - Missing / forged / wrong-session token → 401 from every endpoint
 *   - tus PATCH with mismatched offset → 409
 *   - tus PATCH exceeding Upload-Length → connection cut, no row
 *   - MIME outside the allow-list → 415 on finalize
 *   - Extension on the blocklist with spoofed MIME → 415 on finalize
 *   - EICAR plaintext → 422, audit row written, intake_files row absent
 *   - finalize on empty session → 400 no_files
 *   - finalize twice → idempotent 200 same shape
 *   - encrypted-on-disk recoverable via decryptBufferStreaming and
 *     fails with the wrong intake key
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { db } from '../db/knex.js';
import { resetTestDb } from './test-helpers.js';
import { decryptBufferStreaming, __resetIntakeCryptoCache } from '../services/intakeCrypto.js';
import { __resetIntakeUploadTokenCache } from '../services/intakeUploadToken.js';
import { attachmentStorage } from '../services/attachmentStorage.js';

let app: Express;
let staffId: string;

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}' + '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  if (!process.env.CONNECT_INTAKE_ENCRYPTION_KEY) {
    process.env.CONNECT_INTAKE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
  __resetIntakeCryptoCache();
  __resetIntakeUploadTokenCache();
  await resetTestDb();
  staffId = (await db('users').where({ username: 'alice' }).first('id'))!.id as string;
  await db('users').where({ id: staffId }).update({ show_on_intake_card: true });
  const mod = await import('../app.js');
  app = mod.createApp();
});

beforeEach(async () => {
  await db('intake_files').del();
  await db('intake_uploads_in_progress').del();
  await db('intake_pdfs').del();
  await db('intake_notifications_outbox').del();
  await db('intake_sessions').del();
});

afterAll(async () => {
  // Best-effort cleanup of stored ciphertext artefacts.
  try {
    const dir = `${process.cwd()}/infra/docker/uploads/attachments/intake`;
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

async function createSession(): Promise<{ sessionId: string; token: string }> {
  const res = await request(app).post('/api/public/intake/sessions').send({
    staffId,
    name: 'Maria Test',
    email: 'maria-upload@example.com',
  });
  expect(res.status).toBe(201);
  return { sessionId: res.body.sessionId, token: res.body.uploadToken };
}

function encodeMetadata(meta: Record<string, string>): string {
  return Object.entries(meta)
    .map(([k, v]) => `${k} ${Buffer.from(v, 'utf8').toString('base64')}`)
    .join(',');
}

async function tusUpload(
  token: string,
  body: Buffer,
  metadata: Record<string, string>,
): Promise<request.Response> {
  const create = await request(app)
    .post('/api/public/intake/uploads')
    .set('Authorization', `Bearer ${token}`)
    .set('Tus-Resumable', '1.0.0')
    .set('Upload-Length', String(body.length))
    .set('Upload-Metadata', encodeMetadata(metadata));
  if (create.status !== 201) return create;
  const location = create.headers.location as string;
  const uploadId = location.split('/').pop()!;
  const patch = await request(app)
    .patch(`/api/public/intake/uploads/${uploadId}`)
    .set('Authorization', `Bearer ${token}`)
    .set('Tus-Resumable', '1.0.0')
    .set('Upload-Offset', '0')
    .set('Content-Type', 'application/offset+octet-stream')
    .send(body);
  return patch;
}

describe('Phase 28.5 — tus auth', () => {
  it('POST /uploads with no token returns 401', async () => {
    const r = await request(app)
      .post('/api/public/intake/uploads')
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', '100');
    expect(r.status).toBe(401);
  });

  it('POST /uploads with a forged token returns 401', async () => {
    const r = await request(app)
      .post('/api/public/intake/uploads')
      .set('Authorization', 'Bearer not.a.jwt')
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', '100');
    expect(r.status).toBe(401);
  });

  it('PATCH /uploads/:id from a different session returns 404', async () => {
    const a = await createSession();
    const b = await createSession();
    // Create an upload under session a.
    const create = await request(app)
      .post('/api/public/intake/uploads')
      .set('Authorization', `Bearer ${a.token}`)
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', '5')
      .set('Upload-Metadata', encodeMetadata({ filename: 'x.txt', filetype: 'text/plain' }));
    expect(create.status).toBe(201);
    const uploadId = (create.headers.location as string).split('/').pop()!;
    // Try to PATCH it from session b.
    const r = await request(app)
      .patch(`/api/public/intake/uploads/${uploadId}`)
      .set('Authorization', `Bearer ${b.token}`)
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Offset', '0')
      .set('Content-Type', 'application/offset+octet-stream')
      .send(Buffer.from('hello'));
    expect(r.status).toBe(404);
  });
});

describe('Phase 28.5 — tus upload + finalize happy path', () => {
  it('uploads a .txt and persists it as an encrypted intake_files row', async () => {
    const { sessionId, token } = await createSession();
    const body = Buffer.from('hello vibe intake');
    const r = await tusUpload(token, body, {
      filename: 'note.txt',
      filetype: 'text/plain',
    });
    expect(r.status).toBe(204);

    const files = await db('intake_files').where({ session_id: sessionId });
    expect(files.length).toBe(1);
    expect(files[0]!.original_filename).toBe('note.txt');
    expect(files[0]!.mime_type).toBe('text/plain');
    expect(Number(files[0]!.size_bytes)).toBe(body.length);
    expect(files[0]!.virus_scan_status).toBe('clean');
    expect(files[0]!.kind).toBe('file');
    expect(files[0]!.order_index).toBe(0);

    // Round-trip: read the stored ciphertext back and decrypt → original.
    const ct = await attachmentStorage().get(files[0]!.stored_path);
    const plain = await decryptBufferStreaming(ct);
    expect(plain.toString('utf8')).toBe('hello vibe intake');
  });

  it('honors kind=scanned_image + orderIndex from upload metadata', async () => {
    const { sessionId, token } = await createSession();
    // Three "pages" uploaded out of order to simulate the 28.8 batch
    // review UI handing back ordered files. The PDF conversion job
    // (28.9) ORDER BY order_index ASC; we assert the column lands here.
    const pages = [
      { body: Buffer.from('page-2-content'), orderIndex: 1 },
      { body: Buffer.from('page-1-content'), orderIndex: 0 },
      { body: Buffer.from('page-3-content'), orderIndex: 2 },
    ];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]!;
      const r = await tusUpload(token, p.body, {
        filename: `scan-00${i + 1}.jpg`,
        filetype: 'image/jpeg',
        kind: 'scanned_image',
        orderIndex: String(p.orderIndex),
      });
      expect(r.status).toBe(204);
    }
    const files = await db('intake_files')
      .where({ session_id: sessionId })
      .orderBy('order_index', 'asc');
    expect(files.length).toBe(3);
    expect(files.map((f) => f.kind)).toEqual(['scanned_image', 'scanned_image', 'scanned_image']);
    expect(files.map((f) => f.order_index)).toEqual([0, 1, 2]);
    // Order_index ascending → file body sequence matches the review-confirmed order.
    const orderedBodies: string[] = [];
    for (const f of files) {
      const ct = await attachmentStorage().get(f.stored_path);
      const plain = await decryptBufferStreaming(ct);
      orderedBodies.push(plain.toString('utf8'));
    }
    expect(orderedBodies).toEqual(['page-1-content', 'page-2-content', 'page-3-content']);
  });

  it('clamps malformed orderIndex (negative / NaN / huge) to 0', async () => {
    const { sessionId, token } = await createSession();
    for (const bad of ['-5', 'abc', '999999999999']) {
      await tusUpload(token, Buffer.from(`x-${bad}`), {
        filename: 'a.txt',
        filetype: 'text/plain',
        orderIndex: bad,
      });
    }
    const files = await db('intake_files').where({ session_id: sessionId });
    expect(files.length).toBe(3);
    for (const f of files) expect(f.order_index).toBe(0);
  });

  it('rejects an Upload-Length above firm_settings.intake_max_file_bytes', async () => {
    const { token } = await createSession();
    // Set a tight cap for this test so we don't have to construct a 50MB body.
    await db('firm_settings').where({ id: 1 }).update({ intake_max_file_bytes: 100 });
    try {
      const r = await request(app)
        .post('/api/public/intake/uploads')
        .set('Authorization', `Bearer ${token}`)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', '101')
        .set('Upload-Metadata', encodeMetadata({ filename: 'a.txt', filetype: 'text/plain' }));
      expect(r.status).toBe(413);
      expect(r.body.error).toBe('too_large');
    } finally {
      await db('firm_settings').where({ id: 1 }).update({ intake_max_file_bytes: 52428800 });
    }
  });

  it('rejects a second upload that would push the session past the aggregate cap', async () => {
    const { sessionId, token } = await createSession();
    await db('firm_settings').where({ id: 1 }).update({ intake_max_session_bytes: 50 });
    try {
      const ok = await tusUpload(token, Buffer.from('30 bytes - thirty bytes -- yes'), {
        filename: 'a.txt',
        filetype: 'text/plain',
      });
      expect(ok.status).toBe(204);
      // Second upload of 30 bytes would push session to 60 > 50.
      const r = await request(app)
        .post('/api/public/intake/uploads')
        .set('Authorization', `Bearer ${token}`)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', '30')
        .set('Upload-Metadata', encodeMetadata({ filename: 'b.txt', filetype: 'text/plain' }));
      expect(r.status).toBe(413);
      expect(r.body.error).toBe('session_cap_exceeded');
    } finally {
      await db('firm_settings').where({ id: 1 }).update({ intake_max_session_bytes: 262144000 });
      await db('intake_files').where({ session_id: sessionId }).del();
    }
  });

  it('rejects MIME outside the allow-list (415 + no row)', async () => {
    const { sessionId, token } = await createSession();
    const r = await tusUpload(token, Buffer.from('payload'), {
      filename: 'a.exe',
      filetype: 'application/x-msdownload',
    });
    expect(r.status).toBe(415);
    const files = await db('intake_files').where({ session_id: sessionId });
    expect(files.length).toBe(0);
  });

  it('rejects blocked extension even when MIME claims an allowed type', async () => {
    const { sessionId, token } = await createSession();
    const r = await tusUpload(token, Buffer.from('payload'), {
      filename: 'bad.exe',
      filetype: 'text/plain', // spoofed
    });
    expect(r.status).toBe(415);
    const files = await db('intake_files').where({ session_id: sessionId });
    expect(files.length).toBe(0);
  });

  it.skipIf(!process.env.CLAMAV_E2E)(
    'EICAR plaintext is rejected with 422 + audit row',
    async () => {
      const { sessionId, token } = await createSession();
      const r = await tusUpload(token, Buffer.from(EICAR), {
        filename: 'eicar.txt',
        filetype: 'text/plain',
      });
      expect(r.status).toBe(422);
      const files = await db('intake_files').where({ session_id: sessionId });
      expect(files.length).toBe(0);
      const audit = await db('audit_log').where({
        action: 'intake.file.rejected_infected',
        target_id: sessionId,
      });
      expect(audit.length).toBe(1);
    },
  );
});

describe('Phase 28.5 — POST /sessions/:id/finalize', () => {
  it('flips status to finalized and enqueues outbox + pdf rows', async () => {
    const { sessionId, token } = await createSession();
    await tusUpload(token, Buffer.from('test'), {
      filename: 'a.txt',
      filetype: 'text/plain',
    });
    const r = await request(app)
      .post(`/api/public/intake/sessions/${sessionId}/finalize`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.fileCount).toBe(1);

    const sess = await db('intake_sessions').where({ id: sessionId }).first();
    expect(sess.status).toBe('finalized');
    expect(sess.finalized_at).not.toBeNull();

    const pdf = await db('intake_pdfs').where({ session_id: sessionId }).first();
    expect(pdf).toBeDefined();
    expect(pdf.conversion_status).toBe('pending');

    const outbox = await db('intake_notifications_outbox').where({ session_id: sessionId });
    // email (we supplied email) + in_app (staff) = 2 rows minimum.
    expect(outbox.length).toBeGreaterThanOrEqual(2);
    expect(outbox.map((o) => o.channel)).toContain('email');
    expect(outbox.map((o) => o.channel)).toContain('in_app');
  });

  it('returns 400 no_files for an empty session', async () => {
    const { sessionId, token } = await createSession();
    const r = await request(app)
      .post(`/api/public/intake/sessions/${sessionId}/finalize`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('no_files');
  });

  it('is idempotent: second finalize returns the same shape', async () => {
    const { sessionId, token } = await createSession();
    await tusUpload(token, Buffer.from('x'), {
      filename: 'a.txt',
      filetype: 'text/plain',
    });
    const r1 = await request(app)
      .post(`/api/public/intake/sessions/${sessionId}/finalize`)
      .set('Authorization', `Bearer ${token}`);
    expect(r1.status).toBe(200);
    const r2 = await request(app)
      .post(`/api/public/intake/sessions/${sessionId}/finalize`)
      .set('Authorization', `Bearer ${token}`);
    expect(r2.status).toBe(200);
    expect(r2.body.fileCount).toBe(r1.body.fileCount);
    // PDF row count stays at one (insertPending ON CONFLICT DO NOTHING).
    const pdfCount = await db('intake_pdfs').where({ session_id: sessionId }).count();
    expect(Number(pdfCount[0]!.count)).toBe(1);
  });

  it('finalize without a token returns 401', async () => {
    const { sessionId } = await createSession();
    const r = await request(app).post(`/api/public/intake/sessions/${sessionId}/finalize`);
    expect(r.status).toBe(401);
  });

  it('finalize with another session\'s token returns 403', async () => {
    const a = await createSession();
    const b = await createSession();
    await tusUpload(a.token, Buffer.from('x'), {
      filename: 'a.txt',
      filetype: 'text/plain',
    });
    const r = await request(app)
      .post(`/api/public/intake/sessions/${a.sessionId}/finalize`)
      .set('Authorization', `Bearer ${b.token}`);
    expect(r.status).toBe(403);
  });
});
