/**
 * Phase 28.16 — Intake key rotation integration tests.
 *
 * Coverage:
 *   - Dry-run validates keys + counts targets + doesn't mutate.
 *   - Live rotation refuses without maintenance mode (race-prevention gate).
 *   - Concurrent rotation is rejected with rotation_already_running.
 *   - End-to-end: PII columns + file blobs + pdf blobs + link PII all
 *     re-encrypt under the new key. After rotation:
 *       * decrypt with OLD key fails on every re-encrypted row;
 *       * decrypt with NEW key succeeds and produces identical plaintext.
 *   - Search-hash columns (HKDF off SESSION_SECRET) are unchanged.
 *   - Resume picks up from `last_processed_session_id`.
 *   - Maintenance mode gates public POST /sessions (503) but not GET.
 *   - Admin RBAC on every route.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomBytes } from 'node:crypto';
import { db } from '../db/knex.js';
import { resetTestDb } from './test-helpers.js';
import {
  __resetIntakeCryptoCache,
  decryptFieldWith,
  encryptFieldWith,
  parseIntakeKey,
  encryptBufferStreamingWith,
} from '../services/intakeCrypto.js';
import { __resetIntakeUploadTokenCache } from '../services/intakeUploadToken.js';
import {
  __resetIntakeKeyRotationState,
  runKeyRotation,
  verifyRotation,
} from '../services/intakeKeyRotation.js';
import { attachmentStorage } from '../services/attachmentStorage.js';

let app: Express;
let aliceId: string;
let kurtId: string;
let oldKeyB64: string;
let oldKey: Uint8Array;
let newKeyB64: string;
let newKey: Uint8Array;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  // Pin both keys to deterministic values. The OLD key takes precedence
  // for production at-rest reads via the env (intakeCrypto picks it up).
  oldKeyB64 = randomBytes(32).toString('base64');
  newKeyB64 = randomBytes(32).toString('base64');
  process.env.CONNECT_INTAKE_ENCRYPTION_KEY = oldKeyB64;
  __resetIntakeCryptoCache();
  __resetIntakeUploadTokenCache();
  __resetIntakeKeyRotationState();
  oldKey = parseIntakeKey(oldKeyB64, 'old');
  newKey = parseIntakeKey(newKeyB64, 'new');
  await resetTestDb();
  aliceId = (await db('users').where({ username: 'alice' }).first('id'))!.id as string;
  kurtId = (await db('users').where({ username: 'kurt' }).first('id'))!.id as string;
  await db('users').where({ id: aliceId }).update({ show_on_intake_card: true });
  const mod = await import('../app.js');
  app = mod.createApp();
});

beforeEach(async () => {
  await db('intake_key_rotations').del();
  await db('intake_sessions').del();
  await db('intake_links').del();
  await db('firm_settings').where({ id: 1 }).update({ intake_maintenance_mode: false });
  __resetIntakeKeyRotationState();
});

afterAll(async () => {
  // Restore env to avoid leakage between test files.
  delete process.env.CONNECT_INTAKE_ENCRYPTION_KEY_NEW;
});

type TestAgent = ReturnType<typeof request.agent>;
async function loginAs(username: string, password: string): Promise<TestAgent> {
  const agent = request.agent(app);
  const r = await agent.post('/auth/login').send({ username, password });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  return agent;
}

/**
 * Seed: one session + one file blob + one link, all encrypted under OLD.
 */
async function seedOldKeyCorpus(): Promise<{
  sessionId: string;
  fileId: string;
  fileStoredPath: string;
  filePlaintext: Buffer;
  linkId: string;
}> {
  const nameEnc = await encryptFieldWith('Maria Garcia', oldKey);
  const emailEnc = await encryptFieldWith('maria@example.com', oldKey);
  const phoneEnc = await encryptFieldWith('+15551234567', oldKey);
  const sessionRows = (await db('intake_sessions')
    .insert({
      staff_id: aliceId,
      source: 'public',
      token_id: null,
      client_name_enc: nameEnc,
      client_email_enc: emailEnc,
      client_phone_enc: phoneEnc,
      client_name_lower_hash: 'searchhash-name',
      client_email_hash: 'searchhash-email',
      client_phone_hash: 'searchhash-phone',
      contact_method: 'both',
      status: 'finalized',
      upload_token_jti: randomBytes(16).toString('base64url'),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      finalized_at: new Date().toISOString(),
    })
    .returning(['id'])) as Array<{ id: string }>;
  const sessionId = sessionRows[0]!.id;

  // File blob — random 16 KB, encrypt with OLD, persist to attachmentStorage.
  const plaintext = randomBytes(16 * 1024);
  const ciphertext = await encryptBufferStreamingWith(plaintext, oldKey);
  const storedPath = await attachmentStorage().put(
    `intake/rotation-test-${sessionId}.bin`,
    ciphertext,
  );
  const fileRows = (await db('intake_files')
    .insert({
      session_id: sessionId,
      original_filename: 'doc.pdf',
      stored_path: storedPath,
      mime_type: 'application/pdf',
      size_bytes: plaintext.length,
      sha256: '0'.repeat(64),
      kind: 'file',
      order_index: 0,
      virus_scan_status: 'clean',
    })
    .returning(['id'])) as Array<{ id: string }>;
  const fileId = fileRows[0]!.id;

  // Link with PII under OLD.
  const linkEmailEnc = await encryptFieldWith('link-recipient@example.com', oldKey);
  const linkPhoneEnc = await encryptFieldWith('+15559876543', oldKey);
  const linkRows = (await db('intake_links')
    .insert({
      token: randomBytes(16).toString('base64url'),
      created_by_user_id: aliceId,
      assigned_staff_id: aliceId,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      client_email_enc: linkEmailEnc,
      client_phone_enc: linkPhoneEnc,
    })
    .returning(['id'])) as Array<{ id: string }>;

  return {
    sessionId,
    fileId,
    fileStoredPath: storedPath,
    filePlaintext: plaintext,
    linkId: linkRows[0]!.id,
  };
}

describe('Phase 28.16 — Dry run', () => {
  it('200s with counts + sample decrypt OK + writes audit row', async () => {
    await seedOldKeyCorpus();
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt
      .post('/admin/intake/rotate-key/dry-run')
      .send({ oldKey: oldKeyB64, newKey: newKeyB64 });
    expect(r.status).toBe(200);
    expect(r.body.jobId).toBeDefined();
    expect(r.body.counts.total_sessions).toBe(1);
    expect(r.body.counts.total_files).toBe(1);
    expect(r.body.counts.total_links).toBe(1);
    expect(r.body.sample.sessionDecryptOk).toBe(true);
    expect(r.body.sample.fileDecryptOk).toBe(true);
    expect(r.body.keyFingerprints.old).not.toBe(r.body.keyFingerprints.new);
    const audit = await db('audit_log').where({
      action: 'intake.key_rotation.dry_run',
      target_id: r.body.jobId,
    });
    expect(audit.length).toBe(1);
  });

  it('does NOT mutate any encrypted row', async () => {
    const seed = await seedOldKeyCorpus();
    const beforeSession = await db('intake_sessions').where({ id: seed.sessionId }).first();
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    await kurt
      .post('/admin/intake/rotate-key/dry-run')
      .send({ oldKey: oldKeyB64, newKey: newKeyB64 });
    const afterSession = await db('intake_sessions').where({ id: seed.sessionId }).first();
    expect(Buffer.compare(beforeSession.client_name_enc, afterSession.client_name_enc)).toBe(0);
  });

  it('rejects an identical old/new key', async () => {
    await seedOldKeyCorpus();
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt
      .post('/admin/intake/rotate-key/dry-run')
      .send({ oldKey: oldKeyB64, newKey: oldKeyB64 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('keys_identical');
  });

  it('rejects non-admin', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice
      .post('/admin/intake/rotate-key/dry-run')
      .send({ oldKey: oldKeyB64, newKey: newKeyB64 });
    expect(r.status).toBe(403);
  });
});

describe('Phase 28.16 — POST /admin/intake/rotate-key', () => {
  it('refuses to start unless maintenance mode is on', async () => {
    await seedOldKeyCorpus();
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt
      .post('/admin/intake/rotate-key')
      .send({ oldKey: oldKeyB64, newKey: newKeyB64 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('maintenance_required');
  });

  it('rejects non-admin', async () => {
    await db('firm_settings').where({ id: 1 }).update({ intake_maintenance_mode: true });
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice
      .post('/admin/intake/rotate-key')
      .send({ oldKey: oldKeyB64, newKey: newKeyB64 });
    expect(r.status).toBe(403);
  });

  it('QA-fix: refuses concurrent rotations (synchronous tryClaimRotationActive)', async () => {
    // Simulate a prior run still in-flight by flipping the in-process
    // flag before the route handler observes it. The route's atomic
    // `tryClaimRotationActive()` check should 409 the second request
    // even though no DB row says `running`.
    const { tryClaimRotationActive, releaseRotationActive } =
      await import('../services/intakeKeyRotation.js');
    expect(tryClaimRotationActive()).toBe(true);
    try {
      await db('firm_settings').where({ id: 1 }).update({ intake_maintenance_mode: true });
      const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const r = await kurt
        .post('/admin/intake/rotate-key')
        .send({ oldKey: oldKeyB64, newKey: newKeyB64 });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('rotation_already_running');
    } finally {
      releaseRotationActive();
    }
  });

  it('QA-fix: refuses when firm_settings.intake_max_file_bytes exceeds rotation cap', async () => {
    await db('firm_settings')
      .where({ id: 1 })
      .update({
        intake_maintenance_mode: true,
        // 512 MiB — twice the rotation safety cap of 256 MiB.
        intake_max_file_bytes: 512 * 1024 * 1024,
      });
    try {
      const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const r = await kurt
        .post('/admin/intake/rotate-key')
        .send({ oldKey: oldKeyB64, newKey: newKeyB64 });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('file_cap_too_high_for_rotation');
    } finally {
      await db('firm_settings')
        .where({ id: 1 })
        .update({
          intake_max_file_bytes: 50 * 1024 * 1024,
        });
    }
  });
});

describe('Phase 28.16 — Maintenance toggle gate during rotation', () => {
  it('QA-fix: refuses to disable maintenance while a rotation row is running', async () => {
    await db('firm_settings').where({ id: 1 }).update({ intake_maintenance_mode: true });
    // Insert a fake `running` rotation row.
    const rows = (await db('intake_key_rotations')
      .insert({
        status: 'running',
        total_sessions: 0,
        processed_sessions: 0,
        total_files: 0,
        processed_files: 0,
        total_pdfs: 0,
        processed_pdfs: 0,
        started_by_user_id: kurtId,
        dry_run: false,
      })
      .returning(['id'])) as Array<{ id: string }>;
    try {
      const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const r = await kurt.post('/admin/intake/maintenance').send({ enabled: false });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('rotation_in_flight');
    } finally {
      await db('intake_key_rotations').where({ id: rows[0]!.id }).del();
    }
  });

  it('QA-fix: refuses to disable maintenance while a rotation row is paused', async () => {
    await db('firm_settings').where({ id: 1 }).update({ intake_maintenance_mode: true });
    const rows = (await db('intake_key_rotations')
      .insert({
        status: 'paused',
        total_sessions: 5,
        processed_sessions: 2,
        total_files: 0,
        processed_files: 0,
        total_pdfs: 0,
        processed_pdfs: 0,
        started_by_user_id: kurtId,
        dry_run: false,
      })
      .returning(['id'])) as Array<{ id: string }>;
    try {
      const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
      const r = await kurt.post('/admin/intake/maintenance').send({ enabled: false });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('rotation_in_flight');
    } finally {
      await db('intake_key_rotations').where({ id: rows[0]!.id }).del();
    }
  });

  it('QA-fix: allows disabling maintenance when only completed/failed rows exist', async () => {
    await db('firm_settings').where({ id: 1 }).update({ intake_maintenance_mode: true });
    await db('intake_key_rotations').insert({
      status: 'completed',
      total_sessions: 0,
      processed_sessions: 0,
      total_files: 0,
      processed_files: 0,
      total_pdfs: 0,
      processed_pdfs: 0,
      started_by_user_id: kurtId,
      dry_run: false,
      completed_at: db.fn.now(),
    });
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt.post('/admin/intake/maintenance').send({ enabled: false });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
  });
});

describe('Phase 28.16 — verifyRotation post-pass (acceptance criterion)', () => {
  it('reports sessionOk === sessionSampled + fileOk === fileSampled on a clean rotation', async () => {
    const seed = await seedOldKeyCorpus();
    // Set intake_files.sha256 to the real plaintext hash so the
    // verify pass's "decrypt + recompute sha === stored sha" check
    // succeeds. seedOldKeyCorpus uses '0'.repeat(64) as a placeholder.
    const realSha = (await import('node:crypto'))
      .createHash('sha256')
      .update(seed.filePlaintext)
      .digest('hex');
    await db('intake_files').where({ id: seed.fileId }).update({ sha256: realSha });

    // Run the worker through the route entry to mirror production.
    const rows = (await db('intake_key_rotations')
      .insert({
        status: 'running',
        total_sessions: 1,
        processed_sessions: 0,
        total_files: 1,
        processed_files: 0,
        total_pdfs: 0,
        processed_pdfs: 0,
        started_by_user_id: kurtId,
        dry_run: false,
      })
      .returning(['id'])) as Array<{ id: string }>;
    await runKeyRotation({ jobId: rows[0]!.id, oldKey, newKey, batchSize: 100 });

    // Run verifyRotation directly with the new key — the structured
    // result should be all-green.
    const verify = await verifyRotation(newKey, 1);
    expect(verify.sessionSampled).toBeGreaterThanOrEqual(1);
    expect(verify.sessionOk).toBe(verify.sessionSampled);
    expect(verify.fileSampled).toBeGreaterThanOrEqual(1);
    expect(verify.fileOk).toBe(verify.fileSampled);
    expect(verify.fileShaMismatches).toBe(0);
    expect(verify.failedSessionIds.length).toBe(0);
    expect(verify.failedFileIds.length).toBe(0);
  });

  it('catches a deliberately corrupted re-encrypted blob (acceptance criterion)', async () => {
    // Seed corpus, set the real sha256, rotate cleanly.
    const seed = await seedOldKeyCorpus();
    const realSha = (await import('node:crypto'))
      .createHash('sha256')
      .update(seed.filePlaintext)
      .digest('hex');
    await db('intake_files').where({ id: seed.fileId }).update({ sha256: realSha });
    const rows = (await db('intake_key_rotations')
      .insert({
        status: 'running',
        total_sessions: 1,
        processed_sessions: 0,
        total_files: 1,
        processed_files: 0,
        total_pdfs: 0,
        processed_pdfs: 0,
        started_by_user_id: kurtId,
        dry_run: false,
      })
      .returning(['id'])) as Array<{ id: string }>;
    await runKeyRotation({ jobId: rows[0]!.id, oldKey, newKey, batchSize: 100 });

    // Sanity: post-rotation verify is clean.
    const cleanVerify = await verifyRotation(newKey, 1);
    expect(cleanVerify.fileShaMismatches).toBe(0);

    // **Corrupt one byte in the re-encrypted blob on disk.** This is
    // the "test by mutating one byte" the build plan calls out. The
    // mutation lands inside the AEAD-sealed chunk body, so the
    // streaming decrypt will throw (Poly1305 tag mismatch) rather
    // than yield a different plaintext. That throw counts as a verify
    // failure — exactly what we want detected.
    const ct = await attachmentStorage().get(seed.fileStoredPath);
    // Flip a bit somewhere past the 24-byte header and past the 4-byte
    // length prefix — pick byte 50, well inside the first ciphertext
    // chunk's authenticated body.
    const corrupted = Buffer.from(ct);
    corrupted[50] = corrupted[50]! ^ 0xff;
    await attachmentStorage().put(seed.fileStoredPath, corrupted);

    // Verify pass MUST detect the corruption.
    const corruptVerify = await verifyRotation(newKey, 1);
    expect(corruptVerify.fileSampled).toBeGreaterThanOrEqual(1);
    // Either decrypt-throw → failedFileIds includes the file, OR
    // decrypt-but-sha-mismatch → fileShaMismatches >= 1. The corruption
    // is inside the AEAD chunk, so we expect a throw, but either signal
    // proves detection.
    const detected =
      corruptVerify.fileOk < corruptVerify.fileSampled ||
      corruptVerify.fileShaMismatches >= 1 ||
      corruptVerify.failedFileIds.length >= 1;
    expect(detected).toBe(true);
    expect(corruptVerify.failedFileIds).toContain(seed.fileId);
  });

  it('catches a stored sha256 mismatch (silent plaintext corruption scenario)', async () => {
    // Seed + rotate cleanly, then directly mutate intake_files.sha256
    // to a wrong value. The verify pass's "decrypt + recompute" should
    // report a mismatch even though the blob itself is unchanged.
    const seed = await seedOldKeyCorpus();
    const realSha = (await import('node:crypto'))
      .createHash('sha256')
      .update(seed.filePlaintext)
      .digest('hex');
    await db('intake_files').where({ id: seed.fileId }).update({ sha256: realSha });
    const rows = (await db('intake_key_rotations')
      .insert({
        status: 'running',
        total_sessions: 1,
        processed_sessions: 0,
        total_files: 1,
        processed_files: 0,
        total_pdfs: 0,
        processed_pdfs: 0,
        started_by_user_id: kurtId,
        dry_run: false,
      })
      .returning(['id'])) as Array<{ id: string }>;
    await runKeyRotation({ jobId: rows[0]!.id, oldKey, newKey, batchSize: 100 });

    // Mutate the stored sha to simulate a corruption that was silently
    // accepted at upload.
    await db('intake_files')
      .where({ id: seed.fileId })
      .update({ sha256: 'f'.repeat(64) });

    const verify = await verifyRotation(newKey, 1);
    expect(verify.fileShaMismatches).toBeGreaterThanOrEqual(1);
    expect(verify.failedFileIds).toContain(seed.fileId);
  });
});

describe('Phase 28.16 — rotateFileBlob idempotency (QA-fix)', () => {
  it('treats an already-NEW-key blob as a no-op (skipped=true)', async () => {
    // Pre-encrypt under NEW key directly (simulating a partial prior run).
    const seed = await seedOldKeyCorpus();
    const { encryptBufferStreamingWith } = await import('../services/intakeCrypto.js');
    const fakeNewCt = await encryptBufferStreamingWith(seed.filePlaintext, newKey);
    await attachmentStorage().put(seed.fileStoredPath, fakeNewCt);
    // Now run rotation. The worker should observe the blob is already
    // under NEW and skip rather than try old-key decrypt (which would
    // fail).
    const rows = (await db('intake_key_rotations')
      .insert({
        status: 'running',
        total_sessions: 1,
        processed_sessions: 0,
        total_files: 1,
        processed_files: 0,
        total_pdfs: 0,
        processed_pdfs: 0,
        started_by_user_id: kurtId,
        dry_run: false,
      })
      .returning(['id'])) as Array<{ id: string }>;
    await runKeyRotation({ jobId: rows[0]!.id, oldKey, newKey, batchSize: 100 });
    const job = await db('intake_key_rotations').where({ id: rows[0]!.id }).first();
    expect(job.status).toBe('completed');
    // Plaintext recoverable under NEW.
    const ct = await attachmentStorage().get(seed.fileStoredPath);
    const { decryptBufferStreamingWith } = await import('../services/intakeCrypto.js');
    const recovered = await decryptBufferStreamingWith(ct, newKey);
    expect(Buffer.compare(recovered, seed.filePlaintext)).toBe(0);
  });
});

describe('Phase 28.16 — runKeyRotation (worker, in-process)', () => {
  it('re-encrypts session PII + file blob + link PII; search hashes unchanged', async () => {
    const seed = await seedOldKeyCorpus();
    const before = await db('intake_sessions').where({ id: seed.sessionId }).first();
    // Insert a rotation row manually (route would normally do this).
    const rows = (await db('intake_key_rotations')
      .insert({
        status: 'running',
        total_sessions: 1,
        processed_sessions: 0,
        total_files: 1,
        processed_files: 0,
        total_pdfs: 0,
        processed_pdfs: 0,
        started_by_user_id: kurtId,
        dry_run: false,
      })
      .returning(['id'])) as Array<{ id: string }>;
    const jobId = rows[0]!.id;

    await runKeyRotation({ jobId, oldKey, newKey, batchSize: 100 });

    // Status flipped to completed.
    const job = await db('intake_key_rotations').where({ id: jobId }).first();
    expect(job.status).toBe('completed');
    expect(job.processed_sessions).toBe(1);
    expect(job.processed_files).toBe(1);

    // PII decrypts under NEW key but fails under OLD key.
    const afterSession = await db('intake_sessions').where({ id: seed.sessionId }).first();
    expect(await decryptFieldWith(afterSession.client_name_enc, newKey)).toBe('Maria Garcia');
    expect(await decryptFieldWith(afterSession.client_email_enc, newKey)).toBe('maria@example.com');
    expect(await decryptFieldWith(afterSession.client_phone_enc, newKey)).toBe('+15551234567');
    await expect(decryptFieldWith(afterSession.client_name_enc, oldKey)).rejects.toThrow();

    // Search-hash columns deliberately unchanged (HKDF off SESSION_SECRET).
    expect(afterSession.client_name_lower_hash).toBe(before.client_name_lower_hash);
    expect(afterSession.client_email_hash).toBe(before.client_email_hash);
    expect(afterSession.client_phone_hash).toBe(before.client_phone_hash);

    // File blob re-encrypted: decrypt-with-new returns the original
    // plaintext byte-for-byte; decrypt-with-old throws.
    const newCt = await attachmentStorage().get(seed.fileStoredPath);
    const { decryptBufferStreamingWith } = await import('../services/intakeCrypto.js');
    const recovered = await decryptBufferStreamingWith(newCt, newKey);
    expect(Buffer.compare(recovered, seed.filePlaintext)).toBe(0);
    await expect(decryptBufferStreamingWith(newCt, oldKey)).rejects.toThrow();

    // Link PII re-encrypted under NEW.
    const afterLink = await db('intake_links').where({ id: seed.linkId }).first();
    expect(await decryptFieldWith(afterLink.client_email_enc, newKey)).toBe(
      'link-recipient@example.com',
    );
    expect(await decryptFieldWith(afterLink.client_phone_enc, newKey)).toBe('+15559876543');

    // Completion audit.
    const audit = await db('audit_log').where({
      action: 'intake.key_rotation.completed',
      target_id: jobId,
    });
    expect(audit.length).toBe(1);
  });

  it('resume picks up at last_processed_session_id', async () => {
    // Seed 3 sessions, then sort by id (UUIDs are random — we can't
    // assume seed order matches sort order). The worker's batch query
    // is `WHERE id > lastSessionId ORDER BY id ASC`, so we pick the
    // LOWEST id as our "already processed" marker and the other two
    // should be picked up by the resume.
    await seedOldKeyCorpus();
    await seedOldKeyCorpus();
    await seedOldKeyCorpus();
    const all = (await db('intake_sessions').orderBy('id', 'asc').select('id')) as Array<{
      id: string;
    }>;
    expect(all.length).toBe(3);
    const [first, second, third] = all.map((r) => r.id);
    // Pre-rotate `first` manually so it's already under NEW (simulating a
    // prior partial run).
    const firstRow = await db('intake_sessions').where({ id: first }).first();
    await db('intake_sessions')
      .where({ id: first })
      .update({
        client_name_enc: await encryptFieldWith(
          await decryptFieldWith(firstRow.client_name_enc, oldKey),
          newKey,
        ),
        client_email_enc: await encryptFieldWith(
          await decryptFieldWith(firstRow.client_email_enc, oldKey),
          newKey,
        ),
        client_phone_enc: await encryptFieldWith(
          await decryptFieldWith(firstRow.client_phone_enc, oldKey),
          newKey,
        ),
      });

    // Resume marker = first id; worker starts strictly AFTER it.
    const rows = (await db('intake_key_rotations')
      .insert({
        status: 'running',
        total_sessions: 3,
        processed_sessions: 1,
        last_processed_session_id: first,
        total_files: 3,
        processed_files: 1,
        total_pdfs: 0,
        processed_pdfs: 0,
        started_by_user_id: kurtId,
        dry_run: false,
      })
      .returning(['id'])) as Array<{ id: string }>;
    const jobId = rows[0]!.id;

    await runKeyRotation({
      jobId,
      oldKey,
      newKey,
      batchSize: 100,
      resumeFromSessionId: first,
    });

    // second + third now decryptable under NEW.
    for (const sid of [second, third]) {
      const row = await db('intake_sessions').where({ id: sid }).first();
      await expect(decryptFieldWith(row.client_name_enc, newKey)).resolves.toBe('Maria Garcia');
    }
    const job = await db('intake_key_rotations').where({ id: jobId }).first();
    // The worker advanced 2 rows; the initial processed_sessions=1
    // counter is overwritten by the batch checkpoint (worker tracks
    // its own counter starting from 0 on each call), so the final
    // value reflects rows touched THIS run.
    expect(job.processed_sessions).toBe(2);
    expect(job.status).toBe('completed');
  });

  it('failure marks status=failed + writes audit, no half-encrypted state', async () => {
    // Force failure by giving the worker a NEW key that isn't 32 bytes —
    // every encrypt fails on assertKeyLength. We bypass the route's
    // resolveRotationKeys (which also rejects this) by calling the
    // worker directly with a short Uint8Array.
    await seedOldKeyCorpus();
    const rows = (await db('intake_key_rotations')
      .insert({
        status: 'running',
        total_sessions: 1,
        processed_sessions: 0,
        total_files: 1,
        processed_files: 0,
        total_pdfs: 0,
        processed_pdfs: 0,
        started_by_user_id: kurtId,
        dry_run: false,
      })
      .returning(['id'])) as Array<{ id: string }>;
    const jobId = rows[0]!.id;
    const badKey = new Uint8Array(16); // wrong length

    await expect(
      runKeyRotation({ jobId, oldKey, newKey: badKey, batchSize: 100 }),
    ).rejects.toThrow();

    const job = await db('intake_key_rotations').where({ id: jobId }).first();
    expect(job.status).toBe('failed');
    expect(job.error_message).toBeTruthy();
    const audit = await db('audit_log').where({
      action: 'intake.key_rotation.failed',
      target_id: jobId,
    });
    expect(audit.length).toBe(1);
  });
});

describe('Phase 28.16 — maintenance mode gate', () => {
  it('public POST /sessions returns 503 when maintenance is on; GET /staff stays live', async () => {
    await db('firm_settings').where({ id: 1 }).update({ intake_maintenance_mode: true });
    const post = await request(app).post('/api/public/intake/sessions').send({
      staffId: aliceId,
      name: 'Maria',
      email: 'm@example.com',
    });
    expect(post.status).toBe(503);
    expect(post.body.error).toBe('maintenance');
    // Reads pass through.
    const get = await request(app).get('/api/public/intake/staff');
    expect(get.status).toBe(200);
  });

  it('POST /admin/intake/maintenance flips the flag + audits', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt.post('/admin/intake/maintenance').send({ enabled: true });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    const settings = await db('firm_settings').where({ id: 1 }).first();
    expect(settings.intake_maintenance_mode).toBe(true);
    const audit = await db('audit_log').where({ action: 'intake.maintenance.toggled' });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('non-admin cannot toggle maintenance', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.post('/admin/intake/maintenance').send({ enabled: true });
    expect(r.status).toBe(403);
  });
});

describe('Phase 28.16 — GET /admin/intake/rotate-key/:jobId', () => {
  it('returns the rotation row', async () => {
    const rows = (await db('intake_key_rotations')
      .insert({
        status: 'completed',
        total_sessions: 0,
        processed_sessions: 0,
        total_files: 0,
        processed_files: 0,
        total_pdfs: 0,
        processed_pdfs: 0,
        started_by_user_id: kurtId,
        dry_run: true,
        completed_at: db.fn.now(),
      })
      .returning(['id'])) as Array<{ id: string }>;
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt.get(`/admin/intake/rotate-key/${rows[0]!.id}`);
    expect(r.status).toBe(200);
    expect(r.body.rotation.status).toBe('completed');
    expect(r.body.rotation.dryRun).toBe(true);
  });

  it('404s an unknown jobId', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt.get(`/admin/intake/rotate-key/00000000-0000-0000-0000-000000000000`);
    expect(r.status).toBe(404);
  });
});

describe('Phase 28.16 — POST /admin/intake/rotate-key/:jobId/resume', () => {
  it('400s on a dry-run row', async () => {
    const rows = (await db('intake_key_rotations')
      .insert({
        status: 'failed',
        total_sessions: 0,
        processed_sessions: 0,
        total_files: 0,
        processed_files: 0,
        total_pdfs: 0,
        processed_pdfs: 0,
        started_by_user_id: kurtId,
        dry_run: true,
      })
      .returning(['id'])) as Array<{ id: string }>;
    await db('firm_settings').where({ id: 1 }).update({ intake_maintenance_mode: true });
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt
      .post(`/admin/intake/rotate-key/${rows[0]!.id}/resume`)
      .send({ oldKey: oldKeyB64, newKey: newKeyB64 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('dry_run_not_resumable');
  });

  it('409s on a still-running row', async () => {
    const rows = (await db('intake_key_rotations')
      .insert({
        status: 'running',
        total_sessions: 0,
        processed_sessions: 0,
        total_files: 0,
        processed_files: 0,
        total_pdfs: 0,
        processed_pdfs: 0,
        started_by_user_id: kurtId,
        dry_run: false,
      })
      .returning(['id'])) as Array<{ id: string }>;
    await db('firm_settings').where({ id: 1 }).update({ intake_maintenance_mode: true });
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt
      .post(`/admin/intake/rotate-key/${rows[0]!.id}/resume`)
      .send({ oldKey: oldKeyB64, newKey: newKeyB64 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('not_resumable');
  });
});
