/**
 * Phase 28.9 — PDF conversion ticker integration tests.
 *
 * Each test seeds an intake session via the public POST /sessions +
 * tus-upload happy path so the row state matches what the production
 * ticker will see (encrypted PII columns, real intake_files rows with
 * the right kind + order_index). Then calls `tickOnce` directly and
 * asserts the conversion outcome.
 *
 * We don't drive the actual setInterval here — would slow the test
 * suite and add timing fragility. tickOnce is exported precisely so
 * the test path can claim + process without waiting on the timer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { randomBytes } from 'node:crypto';
import { db } from '../db/knex.js';
import { resetTestDb } from './test-helpers.js';
import { decryptBufferStreaming, __resetIntakeCryptoCache } from '../services/intakeCrypto.js';
import { __resetIntakeUploadTokenCache } from '../services/intakeUploadToken.js';
import { attachmentStorage } from '../services/attachmentStorage.js';
import { processOne, tickOnce } from '../services/intakePdfTicker.js';

let app: Express;
let staffId: string;

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
  await db('users')
    .where({ id: staffId })
    .update({ show_on_intake_card: true, intake_card_title: 'Payroll lead' });
  const mod = await import('../app.js');
  app = mod.createApp();
});

beforeEach(async () => {
  await db('intake_files').del();
  await db('intake_pdfs').del();
  await db('intake_uploads_in_progress').del();
  await db('intake_notifications_outbox').del();
  await db('intake_sessions').del();
});

afterAll(async () => {
  // Stored ciphertext blobs are cleaned via Postgres CASCADE when sessions
  // get deleted; the on-disk attachmentStorage files survive — clean them
  // up here so the dev volume doesn't grow indefinitely test-run to
  // test-run. Failure (storage missing) is ignored.
  const fs = await import('node:fs/promises');
  try {
    await fs.rm(`${process.cwd()}/infra/docker/uploads/attachments/intake`, {
      recursive: true,
      force: true,
    });
  } catch {
    /* swallow */
  }
});

// ---------- helpers ----------

async function createSession(): Promise<{ sessionId: string; token: string }> {
  const r = await request(app).post('/api/public/intake/sessions').send({
    staffId,
    name: 'Maria PdfTest',
    email: 'pdf-test@example.com',
    phone: '+15551234567',
  });
  expect(r.status).toBe(201);
  return { sessionId: r.body.sessionId, token: r.body.uploadToken };
}

function encodeMetadata(meta: Record<string, string>): string {
  return Object.entries(meta)
    .map(([k, v]) => `${k} ${Buffer.from(v, 'utf8').toString('base64')}`)
    .join(',');
}

async function uploadFile(
  token: string,
  body: Buffer,
  metadata: Record<string, string>,
): Promise<void> {
  const create = await request(app)
    .post('/api/public/intake/uploads')
    .set('Authorization', `Bearer ${token}`)
    .set('Tus-Resumable', '1.0.0')
    .set('Upload-Length', String(body.length))
    .set('Upload-Metadata', encodeMetadata(metadata));
  expect(create.status).toBe(201);
  const uploadId = (create.headers.location as string).split('/').pop()!;
  const patch = await request(app)
    .patch(`/api/public/intake/uploads/${uploadId}`)
    .set('Authorization', `Bearer ${token}`)
    .set('Tus-Resumable', '1.0.0')
    .set('Upload-Offset', '0')
    .set('Content-Type', 'application/offset+octet-stream')
    .send(body);
  expect(patch.status).toBe(204);
}

async function makeJpeg(width = 400, height = 300, hex = '#3366aa'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: hex } })
    .jpeg()
    .toBuffer();
}

/** Insert a pending intake_pdfs row for the given session and immediately
 *  claim + process it via processOne — bypasses the timer for tests. */
async function processSession(sessionId: string): Promise<{ id: string }> {
  const fileIds = (await db('intake_files')
    .where({ session_id: sessionId })
    .pluck('id')) as string[];
  const rows = (await db('intake_pdfs')
    .insert({
      session_id: sessionId,
      source_file_ids: db.raw('?::uuid[]', [fileIds]),
      conversion_status: 'pending',
    })
    .returning(['id', 'session_id', 'attempts'])) as Array<{
    id: string;
    session_id: string;
    attempts: number;
  }>;
  const row = rows[0]!;
  // Hand-claim the row so the test bypasses the SELECT FOR UPDATE / time
  // gate, exercises processOne with deterministic input.
  await db('intake_pdfs').where({ id: row.id }).update({
    conversion_status: 'processing',
    conversion_started_at: db.fn.now(),
  });
  await processOne(row);
  return { id: row.id };
}

// ---------- tests ----------

describe('Phase 28.9 — PDF conversion ticker', () => {
  it('produces a cover-page-only PDF for a session with no scanned images', async () => {
    const { sessionId, token } = await createSession();
    await uploadFile(token, Buffer.from('a receipt'), {
      filename: 'receipt.pdf',
      filetype: 'application/pdf',
    });
    const { id } = await processSession(sessionId);

    const pdfRow = await db('intake_pdfs').where({ id }).first();
    expect(pdfRow.conversion_status).toBe('done');
    expect(pdfRow.page_count).toBe(1);
    expect(pdfRow.stored_path).toBeTruthy();
    expect(pdfRow.sha256).toMatch(/^[0-9a-f]{64}$/);

    const ct = await attachmentStorage().get(pdfRow.stored_path);
    const plain = await decryptBufferStreaming(ct);
    // Verify the bytes are a real PDF (pdf-lib parses it back to one page).
    const parsed = await PDFDocument.load(plain);
    expect(parsed.getPageCount()).toBe(1);
  });

  it('produces cover + 3 image pages for a 3-page scan batch', async () => {
    const { sessionId, token } = await createSession();
    for (let i = 0; i < 3; i++) {
      const jpeg = await makeJpeg(400, 300, `#${i}${i}${i}aaa`);
      await uploadFile(token, jpeg, {
        filename: `scan-${String(i + 1).padStart(3, '0')}.jpg`,
        filetype: 'image/jpeg',
        kind: 'scanned_image',
        orderIndex: String(i),
      });
    }
    const { id } = await processSession(sessionId);
    const pdfRow = await db('intake_pdfs').where({ id }).first();
    expect(pdfRow.conversion_status).toBe('done');
    // Cover + 3 image pages.
    expect(pdfRow.page_count).toBe(4);

    const ct = await attachmentStorage().get(pdfRow.stored_path);
    const plain = await decryptBufferStreaming(ct);
    const parsed = await PDFDocument.load(plain);
    expect(parsed.getPageCount()).toBe(4);
  });

  it('handles a mixed session (2 scanned + 1 uploaded file) — cover + 2 image pages', async () => {
    const { sessionId, token } = await createSession();
    // 2 scanned images.
    for (let i = 0; i < 2; i++) {
      const jpeg = await makeJpeg();
      await uploadFile(token, jpeg, {
        filename: `scan-${String(i + 1).padStart(3, '0')}.jpg`,
        filetype: 'image/jpeg',
        kind: 'scanned_image',
        orderIndex: String(i),
      });
    }
    // 1 uploaded PDF (kind defaults to 'file' so it doesn't get embedded).
    await uploadFile(token, Buffer.from('some pdf bytes'), {
      filename: 'receipt.pdf',
      filetype: 'application/pdf',
    });
    const { id } = await processSession(sessionId);
    const pdfRow = await db('intake_pdfs').where({ id }).first();
    expect(pdfRow.conversion_status).toBe('done');
    // Cover + 2 image pages. The receipt.pdf is listed on the cover
    // ("Other files attached") but NOT embedded in the assembled PDF.
    expect(pdfRow.page_count).toBe(3);
  });

  it('also embeds image-mime files uploaded as kind=file (iOS native-camera path)', async () => {
    // Regression guard for the iPhone Safari report where a single
    // IMG_*.jpeg taken via the OS camera fallback arrived as kind='file'
    // and the assembled PDF was cover-page-only (1.5 KB) with the image
    // listed under "Other files attached" instead of as a PDF page.
    // The builder now embeds any file whose mime_type starts with
    // image/, regardless of kind.
    const { sessionId, token } = await createSession();
    const jpeg = await makeJpeg();
    await uploadFile(token, jpeg, {
      filename: 'IMG_3127.jpeg',
      filetype: 'image/jpeg',
      // intentionally no `kind` — defaults to 'file' on the server,
      // mirroring the apps/intake fallback path.
    });
    const { id } = await processSession(sessionId);
    const pdfRow = await db('intake_pdfs').where({ id }).first();
    expect(pdfRow.conversion_status).toBe('done');
    // Cover + 1 image page = 2 pages. Previously: 1 (cover only).
    expect(pdfRow.page_count).toBe(2);
  });

  it('honours firm_settings.intake_include_cover_page=false', async () => {
    const { sessionId, token } = await createSession();
    await db('firm_settings').where({ id: 1 }).update({ intake_include_cover_page: false });
    try {
      const jpeg = await makeJpeg();
      await uploadFile(token, jpeg, {
        filename: 'scan-001.jpg',
        filetype: 'image/jpeg',
        kind: 'scanned_image',
      });
      const { id } = await processSession(sessionId);
      const pdfRow = await db('intake_pdfs').where({ id }).first();
      expect(pdfRow.conversion_status).toBe('done');
      // No cover, just the image — but pdf-lib requires ≥1 page so the
      // builder's safety-net fallback re-injects a cover when image
      // count is 0; for a 1-image-no-cover case we expect exactly 1 page.
      expect(pdfRow.page_count).toBe(1);
    } finally {
      await db('firm_settings').where({ id: 1 }).update({ intake_include_cover_page: true });
    }
  });

  it('retries on transient failure, ends in failed + audit + admin-notify after 3 attempts', async () => {
    const { sessionId } = await createSession();
    // No files at all: buildPdfForSession still succeeds (cover-only),
    // so to test the failure path we corrupt the session's PII column
    // (set client_name_enc to nonsense bytes that intakeCrypto can't
    // decrypt). The build call then throws every attempt.
    await db('intake_sessions')
      .where({ id: sessionId })
      .update({
        client_name_enc: Buffer.from('not-valid-secretbox-ciphertext'),
      });
    // Insert + claim the pdf row by hand for predictable attempts state.
    const rowsIns = (await db('intake_pdfs')
      .insert({ session_id: sessionId, source_file_ids: db.raw('?::uuid[]', [[]]) })
      .returning(['id', 'session_id', 'attempts'])) as Array<{
      id: string;
      session_id: string;
      attempts: number;
    }>;
    const row = rowsIns[0]!;

    // Attempt 1: should go back to pending with attempts=1.
    await db('intake_pdfs').where({ id: row.id }).update({ conversion_status: 'processing' });
    await processOne(row);
    let after = await db('intake_pdfs').where({ id: row.id }).first();
    expect(after.conversion_status).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.error_message).toBeTruthy();

    // Attempt 2.
    await db('intake_pdfs').where({ id: row.id }).update({ conversion_status: 'processing' });
    await processOne({ id: row.id, session_id: row.session_id, attempts: 1 });
    after = await db('intake_pdfs').where({ id: row.id }).first();
    expect(after.conversion_status).toBe('pending');
    expect(after.attempts).toBe(2);

    // Attempt 3 — permanent failure.
    await db('intake_pdfs').where({ id: row.id }).update({ conversion_status: 'processing' });
    await processOne({ id: row.id, session_id: row.session_id, attempts: 2 });
    after = await db('intake_pdfs').where({ id: row.id }).first();
    expect(after.conversion_status).toBe('failed');
    expect(after.attempts).toBe(3);

    // Audit row written.
    const audit = await db('audit_log')
      .where({ action: 'intake.pdf.conversion_failed', target_id: sessionId })
      .first();
    expect(audit).toBeDefined();

    // Admin notification row enqueued (kurt is the only admin in the seed).
    const notifs = await db('intake_notifications_outbox').where({
      session_id: sessionId,
      template_id: 'admin.pdf_conversion_failed',
    });
    expect(notifs.length).toBeGreaterThanOrEqual(1);
  });

  it('tickOnce claims pending rows and processes them through `done`', async () => {
    const { sessionId, token } = await createSession();
    const jpeg = await makeJpeg();
    await uploadFile(token, jpeg, {
      filename: 'scan.jpg',
      filetype: 'image/jpeg',
      kind: 'scanned_image',
    });
    // Insert a pending row without manually claiming — let tickOnce drive
    // the claim path.
    const rowsIns = (await db('intake_pdfs')
      .insert({ session_id: sessionId, source_file_ids: db.raw('?::uuid[]', [[]]) })
      .returning(['id'])) as Array<{ id: string }>;
    const rowId = rowsIns[0]!.id;
    const processed = await tickOnce();
    expect(processed).toBeGreaterThanOrEqual(1);
    const after = await db('intake_pdfs').where({ id: rowId }).first();
    expect(after.conversion_status).toBe('done');
  });
});
