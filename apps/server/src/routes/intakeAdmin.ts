// Phase 28.11 — Staff-facing intake admin routes.
//
// Mounted at `/admin/intake` by app.ts. RBAC:
//   - Authenticated staff sees only sessions where `staff_id = self`.
//   - Admins see all sessions and can filter by `?staffId=<uuid>`.
//
// Every endpoint that surfaces decrypted PII (the detail view, the file
// download, the bulk-zip — that one ships in 28.17) writes an audit row
// BEFORE returning. This is the load-bearing privacy invariant: an
// admin who reads a client's name has left a forensic trail.
//
// Search uses the deterministic `client_*_hash` columns populated at
// session-create time (28.4). The plaintext is HKDF-derived from
// `SESSION_SECRET` per intakeCrypto's `searchHash`, NOT the intake key
// — so the Phase 28.16 intake-key rotation does NOT invalidate search.
import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import sharp from 'sharp';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { effectiveUrls } from '../services/effectiveUrls.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { auditRepo } from '../repositories/audit.js';
import { intakeFilesRepo, intakeSessionsRepo } from '../repositories/intake.js';
import { attachmentStorage } from '../services/attachmentStorage.js';
import {
  decryptBufferStreaming,
  decryptField,
  encryptField,
  hashForAudit,
  parseIntakeKey,
  searchHash,
} from '../services/intakeCrypto.js';
import { applyRetentionBackfill, clearAllAutoDeleteAt } from '../services/intakeAutoPurgeTicker.js';
import {
  countRotationTargets,
  dryRunRotation,
  isRotationActive,
  releaseRotationActive,
  runKeyRotation,
  tryClaimRotationActive,
} from '../services/intakeKeyRotation.js';
import { getEmailProvider } from '../bridges/email/index.js';
import { getSmsProvider } from '../bridges/sms/index.js';

export const intakeAdminRouter = Router();

// 30 searches/min/user — protects the hash lookup from being used as a
// general-purpose oracle (a clean SUCCESS/FAIL hash response IS the
// signal). Keyed on session.userId so the office NAT doesn't share a
// single bucket across staff.
const searchLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.session.userId ?? req.ip ?? 'anon',
});

// -------- list --------

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
  status: z.enum(['open', 'finalized', 'expired', 'abandoned']).optional(),
  staffId: z.string().uuid().optional(),
  fromDate: z.string().optional(), // ISO date or datetime
  toDate: z.string().optional(),
  includeArchived: z.coerce.boolean().optional().default(false),
  // POST /api/public/intake/sessions creates a session row the moment a
  // client fills name/email and clicks Next, BEFORE any tus upload.
  // Visitors who bounce after that produce `status='open' AND
  // file_count=0` ghost rows that pollute the staff list. Default-hide
  // them — staff want to see actual submissions. `includeAbandoned=true`
  // brings them back for admins triaging "why are clients not finishing".
  includeAbandoned: z.coerce.boolean().optional().default(false),
  sort: z
    .enum(['received_at_desc', 'received_at_asc', 'size_desc', 'size_asc'])
    .optional()
    .default('received_at_desc'),
});

intakeAdminRouter.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_query', details: parsed.error.flatten() });
      return;
    }
    const q = parsed.data;
    const isAdmin = Boolean(req.session.isAdmin);
    const me = req.session.userId!;
    // Aggregate file counts + total size per session in a single query
    // so the list view doesn't N+1 against intake_files.
    let query = db('intake_sessions as s')
      .leftJoin(
        db('intake_files')
          .select('session_id')
          .count<{ session_id: string; file_count: string }>('* as file_count')
          .sum<{ total: string }>('size_bytes as total_bytes')
          .groupBy('session_id')
          .as('f'),
        'f.session_id',
        's.id',
      )
      .leftJoin(
        db('intake_session_archives')
          .where({ user_id: me })
          .select('session_id', 'archived_at')
          .as('a'),
        'a.session_id',
        's.id',
      )
      .leftJoin('users as u', 'u.id', 's.staff_id')
      .select<
        Array<{
          id: string;
          staff_id: string;
          staff_display_name: string | null;
          status: string;
          source: string;
          contact_method: string;
          created_at: string;
          finalized_at: string | null;
          notification_failed: boolean;
          linked_connect_client_id: string | null;
          client_name_enc: Buffer | null;
          file_count: string | null;
          total_bytes: string | null;
          archived_at: string | null;
          auto_delete_at: string | null;
        }>
      >([
        's.id',
        's.staff_id',
        { staff_display_name: 'u.display_name' },
        's.status',
        's.source',
        's.contact_method',
        's.created_at',
        's.finalized_at',
        's.notification_failed',
        's.linked_connect_client_id',
        // Pull the encrypted client name so the list view can show who
        // sent each submission. Decryption happens server-side below; a
        // single audit row covers the whole page rather than per-row.
        's.client_name_enc',
        db.raw('COALESCE(f."file_count", 0) as file_count'),
        db.raw('COALESCE(f."total_bytes", 0) as total_bytes'),
        'a.archived_at',
        's.auto_delete_at',
      ]);

    // RBAC.
    if (!isAdmin) {
      query = query.where('s.staff_id', me);
    } else if (q.staffId) {
      query = query.where('s.staff_id', q.staffId);
    }
    if (q.status) query = query.where('s.status', q.status);
    if (q.fromDate) query = query.where('s.created_at', '>=', q.fromDate);
    if (q.toDate) query = query.where('s.created_at', '<=', q.toDate);
    if (!q.includeArchived) query = query.whereNull('a.archived_at');
    // Filter out form-bounce ghost rows (open + 0 files). Skipped when
    // the caller explicitly asks for them OR when filtering by a
    // non-'open' status (in which case file_count=0 is meaningful —
    // e.g. an 'expired' session that ran out the clock with nothing
    // uploaded is a real signal an admin might want to review).
    if (!q.includeAbandoned && (!q.status || q.status === 'open')) {
      query = query.whereRaw(`NOT (s.status = 'open' AND COALESCE(f."file_count", 0) = 0)`);
    }

    // Sort
    switch (q.sort) {
      case 'received_at_asc':
        query = query.orderBy('s.created_at', 'asc');
        break;
      case 'size_desc':
        query = query.orderByRaw('COALESCE(f."total_bytes", 0) DESC');
        break;
      case 'size_asc':
        query = query.orderByRaw('COALESCE(f."total_bytes", 0) ASC');
        break;
      case 'received_at_desc':
      default:
        query = query.orderBy('s.created_at', 'desc');
    }
    const offset = (q.page - 1) * q.pageSize;
    const rows = await query.offset(offset).limit(q.pageSize);

    // Count total for pagination — separate query because the count
    // ignores joins for accuracy. Same RBAC + filters.
    let countQ = db('intake_sessions as s').leftJoin(
      db('intake_session_archives')
        .where({ user_id: me })
        .select('session_id', 'archived_at')
        .as('a'),
      'a.session_id',
      's.id',
    );
    if (!isAdmin) countQ = countQ.where('s.staff_id', me);
    else if (q.staffId) countQ = countQ.where('s.staff_id', q.staffId);
    if (q.status) countQ = countQ.where('s.status', q.status);
    if (q.fromDate) countQ = countQ.where('s.created_at', '>=', q.fromDate);
    if (q.toDate) countQ = countQ.where('s.created_at', '<=', q.toDate);
    if (!q.includeArchived) countQ = countQ.whereNull('a.archived_at');
    const totalRow = await countQ.count<{ count: string }>('* as count').first();
    const total = Number(totalRow?.count ?? 0);

    // Decrypt client names for every row in the page. Bulk-audit ONE row
    // for the listing (action `intake.sessions.list_decrypted`) rather
    // than per-session — every page-load auditing N rows would dwarf the
    // useful audit signal. The per-session detail view still writes
    // `intake.session.decrypted_on_view` on individual opens.
    const sessions: Array<{
      id: string;
      staffId: string;
      staffDisplayName: string | null;
      clientName: string | null;
      status: string;
      source: string;
      contactMethod: string;
      createdAt: string;
      finalizedAt: string | null;
      notificationFailed: boolean;
      linkedConnectClientId: string | null;
      fileCount: number;
      totalBytes: number;
      archivedAt: string | null;
      autoDeleteAt: string | null;
    }> = [];
    let decryptedCount = 0;
    for (const r of rows) {
      let clientName: string | null = null;
      if (r.client_name_enc) {
        try {
          clientName = await decryptField(r.client_name_enc);
          decryptedCount++;
        } catch {
          clientName = null;
        }
      }
      sessions.push({
        id: r.id,
        staffId: r.staff_id,
        staffDisplayName: r.staff_display_name,
        clientName,
        status: r.status,
        source: r.source,
        contactMethod: r.contact_method,
        createdAt: r.created_at,
        finalizedAt: r.finalized_at,
        notificationFailed: r.notification_failed,
        linkedConnectClientId: r.linked_connect_client_id,
        fileCount: Number(r.file_count ?? 0),
        totalBytes: Number(r.total_bytes ?? 0),
        archivedAt: r.archived_at,
        autoDeleteAt: r.auto_delete_at,
      });
    }
    if (decryptedCount > 0) {
      await auditRepo.write({
        actorUserId: req.session.userId ?? null,
        action: 'intake.sessions.list_decrypted',
        targetType: 'intake_session',
        // No single target — use a sentinel "list" id. The details JSON
        // carries the count + filters that produced the listing so an
        // audit reader can reconstruct what the viewer saw.
        targetId: 'list',
        details: {
          row_count: decryptedCount,
          status_filter: q.status ?? null,
          staff_filter: q.staffId ?? null,
          page: q.page,
        },
        ipAddress: req.ip ?? null,
      });
    }

    res.json({ sessions, page: q.page, pageSize: q.pageSize, total });
  }),
);

// -------- detail (decryption-on-view) --------

intakeAdminRouter.get(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionId = req.params.id!;
    const session = await intakeSessionsRepo.byId(sessionId);
    if (!session) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // RBAC: staff can only view their own.
    if (!req.session.isAdmin && session.staff_id !== req.session.userId) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    // Audit BEFORE decrypting. If audit fails (db down mid-request)
    // we never expose the PII — this is the privacy invariant.
    await auditRepo.write({
      actorUserId: req.session.userId ?? null,
      action: 'intake.session.decrypted_on_view',
      targetType: 'intake_session',
      targetId: sessionId,
      details: {
        viewer_ip_hash: req.ip ? hashForAudit(req.ip) : null,
      },
      ipAddress: req.ip ?? null,
    });

    const clientName = await decryptField(session.client_name_enc).catch(() => null);
    const clientEmail = session.client_email_enc
      ? await decryptField(session.client_email_enc).catch(() => null)
      : null;
    const clientPhone = session.client_phone_enc
      ? await decryptField(session.client_phone_enc).catch(() => null)
      : null;
    const clientMessage = session.client_message_enc
      ? await decryptField(session.client_message_enc).catch(() => null)
      : null;

    const files = await intakeFilesRepo.listBySession(sessionId);
    const pdf = await db('intake_pdfs').where({ session_id: sessionId }).first();
    const linkedClient = session.linked_connect_client_id
      ? await db('external_identities')
          .where({ id: session.linked_connect_client_id })
          .first<{ id: string; display_name: string }>('id', 'display_name')
      : null;

    res.json({
      session: {
        id: session.id,
        staffId: session.staff_id,
        source: session.source,
        status: session.status,
        contactMethod: session.contact_method,
        createdAt: session.created_at,
        finalizedAt: session.finalized_at,
        expiresAt: session.expires_at,
        autoDeleteAt: session.auto_delete_at,
        notificationFailed: session.notification_failed,
        ipAddress: session.ip_address,
        // PII decrypted for view. May be null on a decrypt failure
        // (key rotation gone wrong, corrupted bytea) — UI shows
        // "(unavailable)" so staff at least see the session exists.
        clientName,
        clientEmail,
        clientPhone,
        clientMessage,
        linkedClient: linkedClient
          ? { id: linkedClient.id, displayName: linkedClient.display_name }
          : null,
        linkedAt: session.linked_at,
      },
      files: files.map((f) => ({
        id: f.id,
        originalFilename: f.original_filename,
        mimeType: f.mime_type,
        sizeBytes: Number(f.size_bytes),
        sha256: f.sha256,
        kind: f.kind,
        orderIndex: f.order_index,
        virusScanStatus: f.virus_scan_status,
        createdAt: f.created_at,
      })),
      pdf: pdf
        ? {
            id: pdf.id,
            status: pdf.conversion_status,
            pageCount: pdf.page_count,
            sizeBytes: pdf.size_bytes !== null ? Number(pdf.size_bytes) : null,
            errorMessage: pdf.error_message,
          }
        : null,
    });
  }),
);

// -------- file download (streams decrypted plaintext) --------

intakeAdminRouter.get(
  '/sessions/:id/files/:fileId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionId = req.params.id!;
    const fileId = req.params.fileId!;
    const session = await intakeSessionsRepo.byId(sessionId);
    if (!session) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!req.session.isAdmin && session.staff_id !== req.session.userId) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const file = await intakeFilesRepo.byId(fileId);
    if (!file || file.session_id !== sessionId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await auditRepo.write({
      actorUserId: req.session.userId ?? null,
      action: 'intake.file.downloaded',
      targetType: 'intake_file',
      targetId: fileId,
      details: {
        session_id: sessionId,
        filename_hash: hashForAudit(file.original_filename),
        size_bytes: Number(file.size_bytes),
      },
      ipAddress: req.ip ?? null,
    });
    const ciphertext = await attachmentStorage().get(file.stored_path);
    const plaintext = await decryptBufferStreaming(ciphertext);
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Length', String(plaintext.length));
    // `attachment` forces a download dialog. Phase 28.17 will revisit
    // inline preview for image/* and application/pdf — for now staff
    // download and open locally.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.original_filename)}"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(plaintext);
  }),
);

// -------- file thumbnail (image preview) --------
//
// Returns a small JPEG preview for image-mime intake files so the staff
// session-detail UI can render thumbnails inline next to each row. The
// underlying bytes are encrypted at rest with the firm intake key; we
// decrypt in-process, downsample with sharp, and return a fresh JPEG.
// No audit row — this fires once per page render and would otherwise
// drown out actual download events. Cache-Control of 5min lets the
// browser reuse the response across re-renders.
intakeAdminRouter.get(
  '/sessions/:id/files/:fileId/thumbnail',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionId = req.params.id!;
    const fileId = req.params.fileId!;
    const session = await intakeSessionsRepo.byId(sessionId);
    if (!session) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!req.session.isAdmin && session.staff_id !== req.session.userId) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const file = await intakeFilesRepo.byId(fileId);
    if (!file || file.session_id !== sessionId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const mime = (file.mime_type ?? '').toLowerCase();
    if (file.kind !== 'scanned_image' && !mime.startsWith('image/')) {
      // Non-image files have no inline thumbnail — caller should hide
      // the <img> element rather than ever requesting this URL.
      res.status(404).json({ error: 'not_image' });
      return;
    }
    try {
      const ciphertext = await attachmentStorage().get(file.stored_path);
      const plaintext = await decryptBufferStreaming(ciphertext);
      // 192 px on the long edge × 2x DPR = sharp on retina. JPEG at q70
      // — readable at thumbnail size, ~5–15 KB on typical phone photos.
      const thumb = await sharp(plaintext)
        .rotate()
        .resize({ width: 192, height: 192, fit: 'inside' })
        .jpeg({ quality: 70 })
        .toBuffer();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', String(thumb.length));
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(thumb);
    } catch (err) {
      logger.warn('intake.thumbnail_failed', {
        sessionId,
        fileId,
        msg: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'thumbnail_failed' });
    }
  }),
);

// -------- assembled-PDF download --------

intakeAdminRouter.get(
  '/sessions/:id/pdf',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionId = req.params.id!;
    const session = await intakeSessionsRepo.byId(sessionId);
    if (!session) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!req.session.isAdmin && session.staff_id !== req.session.userId) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const pdf = await db('intake_pdfs').where({ session_id: sessionId }).first();
    if (!pdf || pdf.conversion_status !== 'done' || !pdf.stored_path) {
      res.status(404).json({ error: 'pdf_not_ready' });
      return;
    }
    await auditRepo.write({
      actorUserId: req.session.userId ?? null,
      action: 'intake.pdf.downloaded',
      targetType: 'intake_session',
      targetId: sessionId,
      details: { pdfId: pdf.id, sizeBytes: Number(pdf.size_bytes) },
      ipAddress: req.ip ?? null,
    });
    const ct = await attachmentStorage().get(pdf.stored_path);
    const plaintext = await decryptBufferStreaming(ct);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(plaintext.length));
    const ref = createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
    res.setHeader('Content-Disposition', `attachment; filename="intake-${ref}.pdf"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(plaintext);
  }),
);

// -------- search --------

const searchSchema = z.object({
  q: z.string().min(1).max(255),
  field: z.enum(['email', 'phone', 'name']).optional(),
});

intakeAdminRouter.post(
  '/sessions/search',
  requireAuth,
  searchLimiter,
  asyncHandler(async (req, res) => {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const isAdmin = Boolean(req.session.isAdmin);
    const me = req.session.userId!;
    // We compute the hash for every candidate field and OR them — lets
    // the UI offer a single search box without forcing the user to
    // disambiguate.
    const trimmed = parsed.data.q.trim();
    const nameHash = searchHash(trimmed.toLowerCase());
    const emailHash = searchHash(trimmed.toLowerCase());
    const phoneHash = searchHash(trimmed);
    let q = db('intake_sessions as s')
      .where(function () {
        this.where('s.client_name_lower_hash', nameHash)
          .orWhere('s.client_email_hash', emailHash)
          .orWhere('s.client_phone_hash', phoneHash);
      })
      .orderBy('s.created_at', 'desc')
      .limit(50)
      .select('s.id', 's.staff_id', 's.status', 's.created_at', 's.finalized_at');
    if (!isAdmin) q = q.where('s.staff_id', me);
    const rows = await q;
    res.json({
      sessions: rows.map((r) => ({
        id: r.id,
        staffId: r.staff_id,
        status: r.status,
        createdAt: r.created_at,
        finalizedAt: r.finalized_at,
      })),
    });
  }),
);

// -------- archive / unarchive --------

intakeAdminRouter.post(
  '/sessions/:id/archive',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionId = req.params.id!;
    const me = req.session.userId!;
    const session = await intakeSessionsRepo.byId(sessionId);
    if (!session) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!req.session.isAdmin && session.staff_id !== me) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    await db.raw(
      `INSERT INTO intake_session_archives (session_id, user_id, archived_at)
       VALUES (?, ?, NOW())
       ON CONFLICT (session_id, user_id) DO UPDATE SET archived_at = EXCLUDED.archived_at`,
      [sessionId, me],
    );
    await auditRepo.write({
      actorUserId: me,
      action: 'intake.session.archived',
      targetType: 'intake_session',
      targetId: sessionId,
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true });
  }),
);

intakeAdminRouter.delete(
  '/sessions/:id/archive',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionId = req.params.id!;
    const me = req.session.userId!;
    await db('intake_session_archives')
      .where({ session_id: sessionId, user_id: me })
      .update({ archived_at: null });
    await auditRepo.write({
      actorUserId: me,
      action: 'intake.session.unarchived',
      targetType: 'intake_session',
      targetId: sessionId,
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true });
  }),
);

// -------- mark-read (per-staff "viewed" state for the Inbox feed) --------
//
// Fired by the staff app when the AdminIntakeDetail modal mounts. The
// row in intake_session_archives is shared with the archive feature —
// `read_at` and `archived_at` are mutually orthogonal so an explicit
// "Mark unread" path could clear read_at without touching archive.
// Idempotent so a re-mount (close + reopen) doesn't write a new audit
// row; only the first mark-read per staff per session audits.

intakeAdminRouter.post(
  '/sessions/:id/mark-read',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionId = req.params.id!;
    const me = req.session.userId!;
    const session = await intakeSessionsRepo.byId(sessionId);
    if (!session) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!req.session.isAdmin && session.staff_id !== me) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const existing = await db('intake_session_archives')
      .where({ session_id: sessionId, user_id: me })
      .first('read_at');
    if (existing?.read_at) {
      // Already marked read — no-op, no audit row. UI re-mounts on
      // every detail-open should NOT spam the audit log.
      res.json({ ok: true, alreadyRead: true });
      return;
    }
    await db.raw(
      `INSERT INTO intake_session_archives (session_id, user_id, read_at)
       VALUES (?, ?, NOW())
       ON CONFLICT (session_id, user_id) DO UPDATE SET read_at = EXCLUDED.read_at`,
      [sessionId, me],
    );
    await auditRepo.write({
      actorUserId: me,
      action: 'intake.session.read',
      targetType: 'intake_session',
      targetId: sessionId,
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true, alreadyRead: false });
  }),
);

// -------- inbox feed (unviewed intakes for the current staff) --------
//
// Lightweight projection for the staff Inbox page. Returns the sessions
// the staff would care about right now: finalized, not yet read by this
// staff, not archived, scoped to those they're the assigned recipient
// of (admins see all). Limit caps to 20 — the Inbox tile is a heads-up,
// not a full report (that's `GET /admin/intake/sessions`).

intakeAdminRouter.get(
  '/inbox/intakes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = req.session.userId!;
    const isAdmin = req.session.isAdmin === true;
    const rows = (await db('intake_sessions as s')
      .leftJoin(
        db('intake_session_archives')
          .where({ user_id: me })
          .select('session_id', 'archived_at', 'read_at')
          .as('a'),
        'a.session_id',
        's.id',
      )
      .leftJoin(
        db('intake_files')
          .select('session_id')
          .count<{ session_id: string; file_count: string }[]>('* as file_count')
          .groupBy('session_id')
          .as('f'),
        'f.session_id',
        's.id',
      )
      .leftJoin('users as u', 'u.id', 's.staff_id')
      .whereNull('a.archived_at')
      .whereNull('a.read_at')
      // Mirror the list-endpoint filter: form-bounce rows (open + 0
      // files) shouldn't surface on the Inbox either — they're not
      // actionable for staff.
      .whereRaw(`NOT (s.status = 'open' AND COALESCE(f."file_count", 0) = 0)`)
      .modify((q) => {
        if (!isAdmin) q.where('s.staff_id', me);
      })
      .orderBy('s.created_at', 'desc')
      .limit(20)
      .select([
        's.id as id',
        's.staff_id as staff_id',
        's.created_at as created_at',
        's.finalized_at as finalized_at',
        's.status as status',
        's.client_name_enc as client_name_enc',
        'u.display_name as staff_display_name',
        db.raw('COALESCE(f."file_count", 0) as file_count'),
      ])) as Array<{
      id: string;
      staff_id: string;
      created_at: string;
      finalized_at: string | null;
      status: string;
      client_name_enc: Buffer | null;
      staff_display_name: string | null;
      file_count: string;
    }>;
    const sessions = [];
    for (const r of rows) {
      let clientName: string | null = null;
      if (r.client_name_enc) {
        try {
          clientName = await decryptField(r.client_name_enc);
        } catch {
          clientName = null;
        }
      }
      sessions.push({
        id: r.id,
        staffId: r.staff_id,
        staffDisplayName: r.staff_display_name,
        clientName,
        fileCount: Number(r.file_count),
        status: r.status,
        createdAt: r.created_at,
        finalizedAt: r.finalized_at,
      });
    }
    res.json({ sessions });
  }),
);

// -------- link / unlink to Connect client (external_identities) --------

const linkSchema = z.object({ clientId: z.string().uuid() });

intakeAdminRouter.post(
  '/sessions/:id/link-client',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = linkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const sessionId = req.params.id!;
    const me = req.session.userId!;
    const session = await intakeSessionsRepo.byId(sessionId);
    if (!session) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // RBAC: staff can link their own; admin can link any.
    if (!req.session.isAdmin && session.staff_id !== me) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const client = await db('external_identities')
      .where({ id: parsed.data.clientId })
      .whereNull('deactivated_at')
      .first<{ id: string; display_name: string }>('id', 'display_name');
    if (!client) {
      res.status(400).json({ error: 'unknown_client' });
      return;
    }
    await db('intake_sessions').where({ id: sessionId }).update({
      linked_connect_client_id: client.id,
      linked_by_user_id: me,
      linked_at: db.fn.now(),
    });
    await auditRepo.write({
      actorUserId: me,
      action: 'intake.session.client_linked',
      targetType: 'intake_session',
      targetId: sessionId,
      details: { clientId: client.id },
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true, client: { id: client.id, displayName: client.display_name } });
  }),
);

intakeAdminRouter.delete(
  '/sessions/:id/link-client',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionId = req.params.id!;
    const me = req.session.userId!;
    const session = await intakeSessionsRepo.byId(sessionId);
    if (!session) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!req.session.isAdmin && session.staff_id !== me) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    await db('intake_sessions').where({ id: sessionId }).update({
      linked_connect_client_id: null,
      linked_by_user_id: null,
      linked_at: null,
    });
    await auditRepo.write({
      actorUserId: me,
      action: 'intake.session.client_unlinked',
      targetType: 'intake_session',
      targetId: sessionId,
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true });
  }),
);

// -------- search-clients-for-linking helper --------

const clientSearchSchema = z.object({ q: z.string().min(1).max(255).optional() });

intakeAdminRouter.get(
  '/clients',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = clientSearchSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    let q = db('external_identities')
      .whereNull('deactivated_at')
      .select<
        Array<{ id: string; display_name: string; email: string | null }>
      >('id', 'display_name', 'email')
      .orderBy('display_name')
      .limit(20);
    if (parsed.data.q) {
      const like = `%${parsed.data.q.toLowerCase()}%`;
      q = q.where(function () {
        this.whereRaw('LOWER(display_name) LIKE ?', [like]).orWhereRaw('LOWER(email) LIKE ?', [
          like,
        ]);
      });
    }
    const rows = await q;
    res.json({
      clients: rows.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email })),
    });
    void logger; // placeholder reference for future audit-on-search if needed
  }),
);

// ============================================================================
// Phase 28.13 — Send-a-link generator.
//
// Staff create a tokenized URL bound to a specific client contact via
// POST /links. Token is 16 random bytes → 22-char base64url, stored
// UNIQUE on `intake_links.token`. The URL the client receives is
// `${PORTAL_URL}/intake/t/<token>` — 28.14 handles the public landing.
// PORTAL_URL (the CLIENT portal host), not SITE_URL (the staff host):
// intake is client-facing and must avoid the staff auth gate.
//
// Sends are synchronous so the staff member sees "Sent" or a clear
// failure at the moment they hit the button. The 28.10 notification
// ticker isn't involved here.
// ============================================================================

interface SendResult {
  email: boolean;
  sms: boolean;
}

/**
 * Send the link via the channels the staff requested. Returns which
 * sends succeeded so the route can audit + respond per-channel.
 */
async function sendLink(opts: {
  token: string;
  expiresAt: Date;
  email: string | null;
  phone: string | null;
  staffDisplayName: string;
  firmName: string;
  note: string | null;
  /**
   * The CLIENT portal URL base (no trailing slash) to embed in the
   * outbound message. Intake is a client-facing flow: the recipient is
   * the client, not staff, so the link must point at the client portal
   * host (PORTAL_URL / firm_settings.portal_url) — not the staff site
   * (SITE_URL). On appliance deployments these resolve to different
   * subdomains (e.g. client.<domain> vs vibe.<domain>/connect); using
   * siteUrl would send clients to the staff host, where every route
   * auth-gates and redirects to login. Callers compute this once via
   * `(await effectiveUrls()).portalUrl.replace(/\/$/, '')` and pass it
   * through. The DB override at firm_settings.portal_url wins over the
   * PORTAL_URL env var, matching the resolver in effectiveUrls.ts.
   */
  portalUrlBase: string;
}): Promise<SendResult> {
  const url = `${opts.portalUrlBase}/intake/t/${opts.token}`;
  const expiryStr = opts.expiresAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const result: SendResult = { email: false, sms: false };
  if (opts.email) {
    const text = [
      `Hi,`,
      '',
      `${opts.staffDisplayName} at ${opts.firmName} is requesting documents from you.`,
      `Please upload here: ${url}`,
      `This link expires ${expiryStr}.`,
      opts.note ? '' : null,
      opts.note ? `Note: ${opts.note}` : null,
      '',
      `— ${opts.firmName}`,
    ]
      .filter((l) => l !== null)
      .join('\n');
    const provider = await getEmailProvider();
    await provider.send({
      to: opts.email,
      subject: `${opts.firmName}: please upload documents`,
      text,
    });
    result.email = true;
  }
  if (opts.phone) {
    const provider = await getSmsProvider();
    const body = `${opts.firmName}: ${opts.staffDisplayName} requested documents. Upload: ${url} (expires ${expiryStr})`;
    await provider.sendMessage({ to: opts.phone, body });
    result.sms = true;
  }
  return result;
}

const createLinkSchema = z
  .object({
    email: z.string().email().max(255).optional(),
    phone: z
      .string()
      .min(7)
      .max(32)
      .regex(/^[\d\s+()\-.]+$/, 'phone_format')
      .optional(),
    expiresIn: z
      .union([z.literal('24h'), z.literal('7d'), z.literal('30d'), z.string().datetime()])
      .default('7d'),
    note: z.string().max(500).optional(),
    assignedStaffId: z.string().uuid().optional(),
  })
  .strict()
  .refine((d) => Boolean(d.email) || Boolean(d.phone), {
    message: 'contact_required',
    path: ['email'],
  });

function resolveExpiry(expiresIn: string): Date {
  if (expiresIn === '24h') return new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (expiresIn === '7d') return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (expiresIn === '30d') return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return new Date(expiresIn);
}

intakeAdminRouter.post(
  '/links',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = createLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      const isContact =
        flat.fieldErrors.email?.includes('contact_required') ||
        flat.fieldErrors.phone?.includes('contact_required');
      res
        .status(400)
        .json({ error: isContact ? 'contact_required' : 'bad_request', details: flat });
      return;
    }
    const me = req.session.userId!;
    const isAdmin = Boolean(req.session.isAdmin);
    // RBAC: staff can only create links for themselves; admin can target
    // any active staff via `assignedStaffId`.
    const assignedStaffId = parsed.data.assignedStaffId ?? me;
    if (!isAdmin && assignedStaffId !== me) {
      res.status(403).json({ error: 'forbidden_assign_other_staff' });
      return;
    }
    const staff = await db('users')
      .where({ id: assignedStaffId, is_active: true })
      .first<{ id: string; display_name: string }>('id', 'display_name');
    if (!staff) {
      res.status(400).json({ error: 'unknown_staff' });
      return;
    }

    const expiresAt = resolveExpiry(parsed.data.expiresIn);
    if (!(expiresAt.getTime() > Date.now())) {
      res.status(400).json({ error: 'bad_expiry' });
      return;
    }

    // 16 random bytes → base64url is 22 chars (the build plan's spec).
    // crypto.randomBytes is CSPRNG-backed; 128 bits of entropy comfortably
    // unguessable.
    const token = randomBytes(16).toString('base64url');

    const firm = await db('firm_settings')
      .where({ id: 1 })
      .first<{ firm_name: string }>('firm_name');
    const firmName = firm?.firm_name ?? 'Vibe Connect';
    const portalUrlBase = (await effectiveUrls()).portalUrl.replace(/\/$/, '');

    const emailEnc = parsed.data.email ? await encryptField(parsed.data.email) : null;
    const phoneEnc = parsed.data.phone ? await encryptField(parsed.data.phone) : null;

    const [row] = (await db('intake_links')
      .insert({
        token,
        created_by_user_id: me,
        assigned_staff_id: assignedStaffId,
        expires_at: expiresAt.toISOString(),
        client_email_enc: emailEnc,
        client_phone_enc: phoneEnc,
        note_to_client: parsed.data.note ?? null,
      })
      .returning(['id', 'token', 'expires_at'])) as Array<{
      id: string;
      token: string;
      expires_at: string;
    }>;
    const linkRow = row!;

    await auditRepo.write({
      actorUserId: me,
      action: 'intake.link.created',
      targetType: 'intake_link',
      targetId: linkRow.id,
      details: {
        assigned_staff_id: assignedStaffId,
        channels: [parsed.data.email ? 'email' : null, parsed.data.phone ? 'sms' : null].filter(
          Boolean,
        ),
      },
      ipAddress: req.ip ?? null,
    });

    // Synchronous send. If a channel fails we still keep the link row
    // (the admin can resend); we surface the error so the UI shows
    // "email sent, SMS failed".
    let sendError: string | null = null;
    let sendResult: SendResult = { email: false, sms: false };
    try {
      sendResult = await sendLink({
        token,
        expiresAt,
        email: parsed.data.email ?? null,
        phone: parsed.data.phone ?? null,
        staffDisplayName: staff.display_name,
        firmName,
        note: parsed.data.note ?? null,
        portalUrlBase,
      });
      await auditRepo.write({
        actorUserId: me,
        action: 'intake.link.sent',
        targetType: 'intake_link',
        targetId: linkRow.id,
        details: { email: sendResult.email, sms: sendResult.sms },
        ipAddress: req.ip ?? null,
      });
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
      await auditRepo.write({
        actorUserId: me,
        action: 'intake.link.send_failed',
        targetType: 'intake_link',
        targetId: linkRow.id,
        details: { error: sendError.slice(0, 200) },
        ipAddress: req.ip ?? null,
      });
    }

    res.status(201).json({
      link: {
        id: linkRow.id,
        token: linkRow.token,
        url: `${portalUrlBase}/intake/t/${linkRow.token}`,
        expiresAt: linkRow.expires_at,
        send: sendResult,
        sendError,
      },
    });
  }),
);

const listLinksQuery = z.object({
  filter: z.enum(['active', 'expired', 'revoked', 'all']).optional().default('active'),
  staffId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
});

intakeAdminRouter.get(
  '/links',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = listLinksQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_query', details: parsed.error.flatten() });
      return;
    }
    const me = req.session.userId!;
    const isAdmin = Boolean(req.session.isAdmin);
    let q = db('intake_links as l')
      .leftJoin('users as u', 'u.id', 'l.assigned_staff_id')
      .leftJoin('users as c', 'c.id', 'l.created_by_user_id')
      .select<
        Array<{
          id: string;
          token: string;
          assigned_staff_id: string;
          assigned_staff_name: string | null;
          created_by_user_id: string;
          created_by_name: string | null;
          expires_at: string;
          revoked_at: string | null;
          use_count: number;
          client_email_enc: Buffer | null;
          client_phone_enc: Buffer | null;
          note_to_client: string | null;
          created_at: string;
        }>
      >([
        'l.id',
        'l.token',
        'l.assigned_staff_id',
        { assigned_staff_name: 'u.display_name' },
        'l.created_by_user_id',
        { created_by_name: 'c.display_name' },
        'l.expires_at',
        'l.revoked_at',
        'l.use_count',
        'l.client_email_enc',
        'l.client_phone_enc',
        'l.note_to_client',
        'l.created_at',
      ])
      .orderBy('l.created_at', 'desc');
    // RBAC
    if (!isAdmin) {
      q = q.where(function () {
        this.where('l.assigned_staff_id', me).orWhere('l.created_by_user_id', me);
      });
    } else if (parsed.data.staffId) {
      q = q.where('l.assigned_staff_id', parsed.data.staffId);
    }
    switch (parsed.data.filter) {
      case 'active':
        q = q.whereNull('l.revoked_at').where('l.expires_at', '>', db.fn.now());
        break;
      case 'expired':
        q = q.whereNull('l.revoked_at').where('l.expires_at', '<=', db.fn.now());
        break;
      case 'revoked':
        q = q.whereNotNull('l.revoked_at');
        break;
      case 'all':
        break;
    }
    const offset = (parsed.data.page - 1) * parsed.data.pageSize;
    const rows = await q.offset(offset).limit(parsed.data.pageSize);
    // Resolve once, reuse for every row in the map below — avoids N
    // identical firm_settings reads on a list endpoint.
    const portalUrlBase = (await effectiveUrls()).portalUrl.replace(/\/$/, '');

    // Decrypt the encrypted contact columns for display. Each is wrapped
    // in try/catch so one bad row (key-rotation incident) doesn't 500
    // the whole list.
    const decrypted = await Promise.all(
      rows.map(async (r) => {
        const email = r.client_email_enc
          ? await decryptField(r.client_email_enc).catch(() => null)
          : null;
        const phone = r.client_phone_enc
          ? await decryptField(r.client_phone_enc).catch(() => null)
          : null;
        return {
          id: r.id,
          // Token is included for the "copy link" affordance on the UI.
          // The link IS the secret; staff who can see this list could
          // already issue one themselves.
          url: `${portalUrlBase}/intake/t/${r.token}`,
          assignedStaffId: r.assigned_staff_id,
          assignedStaffName: r.assigned_staff_name,
          createdByUserId: r.created_by_user_id,
          createdByName: r.created_by_name,
          expiresAt: r.expires_at,
          revokedAt: r.revoked_at,
          useCount: r.use_count,
          email,
          phone,
          note: r.note_to_client,
          createdAt: r.created_at,
        };
      }),
    );

    res.json({
      links: decrypted,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
  }),
);

intakeAdminRouter.post(
  '/links/:id/revoke',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const me = req.session.userId!;
    const isAdmin = Boolean(req.session.isAdmin);
    const link = await db('intake_links').where({ id }).first();
    if (!link) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!isAdmin && link.assigned_staff_id !== me && link.created_by_user_id !== me) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (link.revoked_at) {
      // Idempotent: already-revoked link returns the same shape rather
      // than an error.
      res.json({ ok: true, alreadyRevoked: true });
      return;
    }
    await db('intake_links').where({ id }).update({ revoked_at: db.fn.now() });
    await auditRepo.write({
      actorUserId: me,
      action: 'intake.link.revoked',
      targetType: 'intake_link',
      targetId: id,
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true });
  }),
);

intakeAdminRouter.post(
  '/links/:id/resend',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const me = req.session.userId!;
    const isAdmin = Boolean(req.session.isAdmin);
    const link = await db('intake_links').where({ id }).first();
    if (!link) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!isAdmin && link.assigned_staff_id !== me && link.created_by_user_id !== me) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (link.revoked_at) {
      res.status(400).json({ error: 'revoked' });
      return;
    }
    if (new Date(link.expires_at).getTime() <= Date.now()) {
      res.status(400).json({ error: 'expired' });
      return;
    }
    const staff = await db('users')
      .where({ id: link.assigned_staff_id })
      .first<{ display_name: string }>('display_name');
    const firm = await db('firm_settings')
      .where({ id: 1 })
      .first<{ firm_name: string }>('firm_name');
    const email = link.client_email_enc
      ? await decryptField(link.client_email_enc).catch(() => null)
      : null;
    const phone = link.client_phone_enc
      ? await decryptField(link.client_phone_enc).catch(() => null)
      : null;
    const portalUrlBase = (await effectiveUrls()).portalUrl.replace(/\/$/, '');
    let sendError: string | null = null;
    let sendResult: SendResult = { email: false, sms: false };
    try {
      sendResult = await sendLink({
        token: link.token,
        expiresAt: new Date(link.expires_at),
        email,
        phone,
        staffDisplayName: staff?.display_name ?? '(staff)',
        firmName: firm?.firm_name ?? 'Vibe Connect',
        note: link.note_to_client,
        portalUrlBase,
      });
      await auditRepo.write({
        actorUserId: me,
        action: 'intake.link.resent',
        targetType: 'intake_link',
        targetId: id,
        details: { email: sendResult.email, sms: sendResult.sms },
        ipAddress: req.ip ?? null,
      });
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
      await auditRepo.write({
        actorUserId: me,
        action: 'intake.link.resend_failed',
        targetType: 'intake_link',
        targetId: id,
        details: { error: sendError.slice(0, 200) },
        ipAddress: req.ip ?? null,
      });
      res.status(500).json({ error: 'send_failed', detail: sendError });
      return;
    }
    res.json({ ok: true, send: sendResult });
  }),
);

// ============================================================================
// Phase 28.11 (QA-followup) — Bulk-zip download.
//
// Staff selects N sessions in the list view and POSTs the IDs here. The
// route streams a zip containing one folder per session with the
// assembled PDF + every uploaded file, decrypted on the fly. Memory
// footprint is bounded by the archiver pipeline + a single in-flight
// file buffer — never the full corpus.
//
// RBAC: staff can include only sessions assigned to themselves; admin
// can include any. Bad ids in the list (not found, not authorized) are
// silently skipped with one audit row recording the skip — the zip is
// best-effort to avoid a "one bad apple kills the export" failure mode.
// ============================================================================

const bulkZipSchema = z
  .object({
    sessionIds: z.array(z.string().uuid()).min(1).max(200),
  })
  .strict();

intakeAdminRouter.post(
  '/sessions/zip',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = bulkZipSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const me = req.session.userId!;
    const isAdmin = Boolean(req.session.isAdmin);

    // Pre-flight: load all referenced sessions, filter by RBAC, drop
    // ids that don't exist. We do this before opening the response
    // stream so a 404/403 can be returned cleanly.
    const sessions = await db('intake_sessions').whereIn('id', parsed.data.sessionIds).select<
      Array<{
        id: string;
        staff_id: string;
        client_name_enc: Buffer;
        finalized_at: string | null;
        status: string;
      }>
    >('id', 'staff_id', 'client_name_enc', 'finalized_at', 'status');
    const authorised = sessions.filter((s) => isAdmin || s.staff_id === me);
    if (authorised.length === 0) {
      res.status(404).json({ error: 'no_sessions_authorised' });
      return;
    }
    const skipped = parsed.data.sessionIds.filter((id) => !authorised.some((s) => s.id === id));

    // Open the response BEFORE we start streaming bytes. An archiver
    // error mid-stream cannot un-send headers, so we set them once and
    // commit to the body — any error then ends the connection with a
    // truncated zip the client will detect (zip footer missing).
    const archiver = (await import('archiver')).default;
    const archive = archiver('zip', { zlib: { level: 6 } });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="intake-bulk-${stamp}.zip"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    archive.on('error', (err) => {
      logger.error('intake.bulk_zip_archiver_error', {
        err: err instanceof Error ? err.message : String(err),
      });
      // Tear down the response on archiver-level failure; the client
      // will see a truncated download.
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    });
    archive.pipe(res);

    const storage = attachmentStorage();
    const includedSessionIds: string[] = [];

    for (const session of authorised) {
      // Decrypt the client name so the folder name is human-meaningful.
      // Fall back to the session id slug on decrypt failure (corrupt row,
      // mid-rotation, etc.) so the zip doesn't abort.
      let folder: string;
      try {
        const name = await decryptField(session.client_name_enc);
        folder = sanitizeForZipPath(`${name} (${session.id.slice(0, 8)})`);
      } catch {
        folder = `unknown-${session.id.slice(0, 8)}`;
      }

      // Audit BEFORE adding bytes — same privacy invariant as
      // intake.session.decrypted_on_view: a download that fails after
      // partial bytes-on-wire still leaves a forensic row.
      await auditRepo.write({
        actorUserId: me,
        action: 'intake.bulk_zip.included',
        targetType: 'intake_session',
        targetId: session.id,
        details: { folder, session_status: session.status },
        ipAddress: req.ip ?? null,
      });

      // Add the assembled PDF if it's ready.
      const pdf = await db('intake_pdfs').where({ session_id: session.id }).first<{
        stored_path: string | null;
        conversion_status: string;
      }>('stored_path', 'conversion_status');
      if (pdf?.conversion_status === 'done' && pdf.stored_path) {
        try {
          const ct = await storage.get(pdf.stored_path);
          const plaintext = await decryptBufferStreaming(ct);
          archive.append(plaintext, { name: `${folder}/_assembled.pdf` });
        } catch (err) {
          logger.warn('intake.bulk_zip_pdf_skipped', {
            sessionId: session.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Add each original file.
      const files = (await db('intake_files')
        .where({ session_id: session.id })
        .orderBy('order_index', 'asc')
        .select<
          Array<{ id: string; original_filename: string; stored_path: string; mime_type: string }>
        >('id', 'original_filename', 'stored_path', 'mime_type')) as Array<{
        id: string;
        original_filename: string;
        stored_path: string;
        mime_type: string;
      }>;
      for (const f of files) {
        try {
          const ct = await storage.get(f.stored_path);
          const plaintext = await decryptBufferStreaming(ct);
          const safeName = sanitizeForZipPath(f.original_filename);
          archive.append(plaintext, { name: `${folder}/${safeName}` });
        } catch (err) {
          logger.warn('intake.bulk_zip_file_skipped', {
            sessionId: session.id,
            fileId: f.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      includedSessionIds.push(session.id);
    }

    // Manifest file at the zip root so the operator can see exactly
    // what was included + what was skipped + when.
    const manifest = [
      `Vibe Connect — Bulk intake export`,
      `Generated: ${new Date().toISOString()}`,
      `By: user_id=${me}`,
      `Sessions included (${includedSessionIds.length}):`,
      ...includedSessionIds.map((id) => `  - ${id}`),
      ...(skipped.length > 0
        ? [
            ``,
            `Sessions skipped (${skipped.length}) — not authorised or not found:`,
            ...skipped.map((id) => `  - ${id}`),
          ]
        : []),
    ].join('\n');
    archive.append(manifest, { name: '_MANIFEST.txt' });

    await auditRepo.write({
      actorUserId: me,
      action: 'intake.bulk_zip.exported',
      targetType: 'audit_log',
      targetId: null,
      details: {
        included: includedSessionIds.length,
        skipped: skipped.length,
        requested: parsed.data.sessionIds.length,
      },
      ipAddress: req.ip ?? null,
    });

    await archive.finalize();
  }),
);

function sanitizeForZipPath(name: string): string {
  // Strip control chars + path separators, collapse to a safe filename.
  // Truncate at 200 chars so a malicious super-long filename can't blow
  // up the zip central directory. ESLint's `no-control-regex` flags
  // `[\x00-\x1f]` literally — we mean the control range here on purpose,
  // so the disable comment is the documented-and-correct workaround.
  // eslint-disable-next-line no-control-regex
  const stripControl = name.replace(/[\x00-\x1f\\/]/g, '_');
  return stripControl.replace(/^\.+/, '_').slice(0, 200) || 'unnamed';
}

// ============================================================================
// Phase 28.15 — Firm settings + per-session retention override.
//
// Single firm_settings row (id=1) carries every intake-wide knob. GET
// returns all of them; PATCH validates with zod against the same caps
// the DB CHECK constraints enforce (after_days 30..3650, etc.). On
// toggle of `intake_auto_delete_enabled` we apply backfill or clearing
// so historical sessions follow the new policy.
//
// RBAC: admin-only. The settings page in apps/web is gated on
// req.session.isAdmin; the routes mirror that check.
// ============================================================================

const settingsPatchSchema = z
  .object({
    intake_auto_delete_enabled: z.boolean().optional(),
    intake_auto_delete_after_days: z.number().int().min(30).max(3650).optional(),
    intake_send_to_both_channels: z.boolean().optional(),
    intake_max_file_bytes: z.number().int().min(1_048_576).max(5_368_709_120).optional(),
    intake_max_session_bytes: z.number().int().min(1_048_576).max(53_687_091_200).optional(),
    intake_conversion_concurrency: z.number().int().min(1).max(16).optional(),
    intake_include_cover_page: z.boolean().optional(),
    intake_digest_hour_local: z.number().int().min(0).max(23).optional(),
    intake_maintenance_mode: z.boolean().optional(),
  })
  .strict();

type SettingsRow = {
  intake_auto_delete_enabled: boolean;
  intake_auto_delete_after_days: number;
  intake_send_to_both_channels: boolean;
  intake_max_file_bytes: string | number;
  intake_max_session_bytes: string | number;
  intake_conversion_concurrency: number;
  intake_include_cover_page: boolean;
  intake_digest_hour_local: number;
  intake_maintenance_mode: boolean;
};

const SETTINGS_COLUMNS = [
  'intake_auto_delete_enabled',
  'intake_auto_delete_after_days',
  'intake_send_to_both_channels',
  'intake_max_file_bytes',
  'intake_max_session_bytes',
  'intake_conversion_concurrency',
  'intake_include_cover_page',
  'intake_digest_hour_local',
  'intake_maintenance_mode',
] as const;

function projectSettings(row: SettingsRow): Record<string, unknown> {
  return {
    intake_auto_delete_enabled: row.intake_auto_delete_enabled,
    intake_auto_delete_after_days: row.intake_auto_delete_after_days,
    intake_send_to_both_channels: row.intake_send_to_both_channels,
    // bigint columns deserialise as string via node-postgres. The admin
    // UI wants numbers — these are bounded at 5 GB / 50 GB so casting is
    // safe (Number.MAX_SAFE_INTEGER is ~9 quadrillion).
    intake_max_file_bytes: Number(row.intake_max_file_bytes),
    intake_max_session_bytes: Number(row.intake_max_session_bytes),
    intake_conversion_concurrency: row.intake_conversion_concurrency,
    intake_include_cover_page: row.intake_include_cover_page,
    intake_digest_hour_local: row.intake_digest_hour_local,
    intake_maintenance_mode: row.intake_maintenance_mode,
  };
}

intakeAdminRouter.get(
  '/settings',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.session.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const row = await db('firm_settings')
      .where({ id: 1 })
      .first<SettingsRow>(SETTINGS_COLUMNS as unknown as string[]);
    if (!row) {
      res.status(500).json({ error: 'firm_settings_missing' });
      return;
    }
    res.json({ settings: projectSettings(row) });
  }),
);

intakeAdminRouter.patch(
  '/settings',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.session.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const patch = parsed.data;
    if (Object.keys(patch).length === 0) {
      // No-op patch: return current state without writing an audit row.
      // Mirrors the intake-card self-write short-circuit (CLAUDE.md
      // review-fix from Phase 28.4: empty PATCH must not leave a
      // spurious audit footprint).
      const row = await db('firm_settings')
        .where({ id: 1 })
        .first<SettingsRow>(SETTINGS_COLUMNS as unknown as string[]);
      res.json({ settings: projectSettings(row!) });
      return;
    }

    // Snapshot pre-write state so the audit detail can carry a diff and
    // the retention-policy toggle path knows whether enabled actually
    // transitioned (PATCH with `enabled:true` when already `true` must
    // not trigger another backfill).
    const before = await db('firm_settings')
      .where({ id: 1 })
      .first<SettingsRow>(SETTINGS_COLUMNS as unknown as string[]);
    if (!before) {
      res.status(500).json({ error: 'firm_settings_missing' });
      return;
    }

    await db('firm_settings').where({ id: 1 }).update(patch);

    // Retention-policy side effects.
    let backfillTouched: number | null = null;
    let clearedTouched: number | null = null;
    if (
      'intake_auto_delete_enabled' in patch &&
      patch.intake_auto_delete_enabled !== before.intake_auto_delete_enabled
    ) {
      if (patch.intake_auto_delete_enabled === true) {
        // Flip OFF→ON: backfill historical finalized sessions with a
        // 7-day-minimum auto_delete_at. Uses the *new* after_days when
        // present in this same PATCH, otherwise the pre-existing value.
        const afterDays =
          patch.intake_auto_delete_after_days ?? before.intake_auto_delete_after_days;
        const { touched } = await applyRetentionBackfill(afterDays);
        backfillTouched = touched;
      } else {
        // Flip ON→OFF: clear every auto_delete_at. "Off means off."
        const { touched } = await clearAllAutoDeleteAt();
        clearedTouched = touched;
      }
    }

    const after = await db('firm_settings')
      .where({ id: 1 })
      .first<SettingsRow>(SETTINGS_COLUMNS as unknown as string[]);

    // Audit detail carries only the field names that changed plus the
    // before/after values. No PII in firm_settings, so this is safe
    // to log verbatim.
    const changedFields: Record<string, { before: unknown; after: unknown }> = {};
    for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
      const b = (before as unknown as Record<string, unknown>)[k];
      const a = (after as unknown as Record<string, unknown>)[k];
      if (b !== a) {
        changedFields[k] = { before: b, after: a };
      }
    }
    await auditRepo.write({
      actorUserId: req.session.userId ?? null,
      action: 'intake.settings.updated',
      targetType: 'firm_settings',
      targetId: '1',
      details: {
        changed: changedFields,
        retention_backfill_touched: backfillTouched,
        retention_cleared_touched: clearedTouched,
      },
      ipAddress: req.ip ?? null,
    });

    res.json({ settings: projectSettings(after!) });
  }),
);

// -------- Per-session retention override --------
//
// Admin-only "Keep this session indefinitely" / "Revert to firm policy"
// on the session detail view. The first action sets auto_delete_at=NULL;
// the second re-derives it from the current firm policy (or leaves NULL
// when the policy is disabled).

intakeAdminRouter.post(
  '/sessions/:id/keep-indefinitely',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.session.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const sessionId = req.params.id!;
    const session = await intakeSessionsRepo.byId(sessionId);
    if (!session) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const previous = session.auto_delete_at;
    await db('intake_sessions').where({ id: sessionId }).update({ auto_delete_at: null });
    await auditRepo.write({
      actorUserId: req.session.userId ?? null,
      action: 'intake.session.retention_overridden',
      targetType: 'intake_session',
      targetId: sessionId,
      details: { previous_auto_delete_at: previous, next_auto_delete_at: null },
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true, autoDeleteAt: null });
  }),
);

intakeAdminRouter.delete(
  '/sessions/:id/keep-indefinitely',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.session.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const sessionId = req.params.id!;
    const session = await intakeSessionsRepo.byId(sessionId);
    if (!session) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (session.status !== 'finalized' || !session.finalized_at) {
      // Reverting policy only makes sense for finalized sessions; an
      // 'open' session never had an auto_delete_at to begin with.
      res.status(400).json({ error: 'not_finalized' });
      return;
    }
    const firm = await db('firm_settings').where({ id: 1 }).first<{
      intake_auto_delete_enabled: boolean;
      intake_auto_delete_after_days: number;
    }>(['intake_auto_delete_enabled', 'intake_auto_delete_after_days']);
    let nextAutoDeleteAt: string | null = null;
    if (firm?.intake_auto_delete_enabled) {
      // Same shape as applyRetentionBackfill: at least 7 days of grace
      // so an immediate revert can't make the session purge in the
      // next sweep.
      const result = (await db.raw<{ rows: Array<{ auto_delete_at: string }> }>(
        `UPDATE intake_sessions
           SET auto_delete_at = GREATEST(
             NOW() + INTERVAL '7 days',
             finalized_at + (?::text || ' days')::interval
           )
         WHERE id = ?
         RETURNING auto_delete_at`,
        [String(firm.intake_auto_delete_after_days), sessionId],
      )) as unknown as { rows: Array<{ auto_delete_at: string }> };
      nextAutoDeleteAt = result.rows[0]?.auto_delete_at ?? null;
    } else {
      // Policy is off; reverting leaves auto_delete_at NULL. Audit row
      // still fires so the trail records the admin's intent.
      await db('intake_sessions').where({ id: sessionId }).update({ auto_delete_at: null });
    }
    await auditRepo.write({
      actorUserId: req.session.userId ?? null,
      action: 'intake.session.retention_overridden',
      targetType: 'intake_session',
      targetId: sessionId,
      details: {
        previous_auto_delete_at: session.auto_delete_at,
        next_auto_delete_at: nextAutoDeleteAt,
        reverted_to_firm_policy: true,
      },
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true, autoDeleteAt: nextAutoDeleteAt });
  }),
);

// ============================================================================
// Phase 28.16 — Intake key rotation + maintenance mode.
//
// Operator workflow:
//   1. POST /admin/intake/maintenance {enabled:true}     — gates writes.
//   2. POST /admin/intake/rotate-key/dry-run             — validates keys.
//   3. POST /admin/intake/rotate-key                     — starts the run.
//   4. GET  /admin/intake/rotate-key/:jobId  (poll)      — observe progress.
//   5. Swap env vars + restart                            — promote new key.
//   6. POST /admin/intake/maintenance {enabled:false}    — re-open intake.
//
// Keys can come from request body OR env vars
// (CONNECT_INTAKE_ENCRYPTION_KEY = current/old, CONNECT_INTAKE_ENCRYPTION_KEY_NEW
// = new). Body overrides env so an operator can dry-run against a fresh
// candidate key without bouncing the server. The body never appears in
// audit details (the keys themselves are NEVER logged); only fingerprints.
// ============================================================================

/**
 * Truncated SHA-256 fingerprint of a key. Logged + audited; the key
 * itself is never persisted anywhere readable. 16 hex chars (64 bits)
 * is enough to distinguish keys for forensic correlation.
 */
function keyFingerprint(key: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(key)).digest('hex').slice(0, 16);
}

/**
 * Hard safety cap on the per-file size the rotation worker will accept.
 * `rotateFileBlob` allocates ~3× the file (oldCt + plaintext + newCt +
 * verify) in memory and Node's Buffer ceiling is ~4 GiB; 256 MiB keeps
 * peak usage well under the ceiling even when multiple sessions
 * interleave. Admins who need larger files must either raise this cap
 * (after streaming-to-tmpfile support lands) or temporarily lower
 * `firm_settings.intake_max_file_bytes` before rotating.
 */
const ROTATION_MAX_FILE_BYTES = 256 * 1024 * 1024;

const rotateBodySchema = z
  .object({
    oldKey: z.string().optional(),
    newKey: z.string().optional(),
    batchSize: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

/**
 * Resolve old + new keys from body (preferred) or env (fallback).
 * Throws a typed error string the route converts to a 400.
 */
function resolveRotationKeys(body: {
  oldKey?: string;
  newKey?: string;
}): { oldKey: Uint8Array; newKey: Uint8Array } | { error: string } {
  const oldRaw = body.oldKey ?? env.connectIntakeEncryptionKey;
  const newRaw = body.newKey ?? env.connectIntakeEncryptionKeyNew;
  if (!oldRaw) return { error: 'old_key_required' };
  if (!newRaw) return { error: 'new_key_required' };
  try {
    const oldKey = parseIntakeKey(oldRaw, 'old key');
    const newKey = parseIntakeKey(newRaw, 'new key');
    if (Buffer.from(oldKey).equals(Buffer.from(newKey))) {
      return { error: 'keys_identical' };
    }
    return { oldKey, newKey };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

intakeAdminRouter.post(
  '/rotate-key/dry-run',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.session.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = rotateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const resolved = resolveRotationKeys(parsed.data);
    if ('error' in resolved) {
      res.status(400).json({ error: resolved.error });
      return;
    }
    const result = await dryRunRotation(resolved);
    // Insert a dry-run row so the audit log shows the validation step.
    const rows = (await db('intake_key_rotations')
      .insert({
        status: 'completed',
        total_sessions: result.counts.total_sessions,
        processed_sessions: 0,
        total_files: result.counts.total_files,
        processed_files: 0,
        total_pdfs: result.counts.total_pdfs,
        processed_pdfs: 0,
        started_by_user_id: req.session.userId!,
        dry_run: true,
        completed_at: db.fn.now(),
      })
      .returning(['id'])) as Array<{ id: string }>;
    const jobId = rows[0]!.id;
    await auditRepo.write({
      actorUserId: req.session.userId ?? null,
      action: 'intake.key_rotation.dry_run',
      targetType: 'intake_key_rotation',
      targetId: jobId,
      details: {
        old_key_fp: keyFingerprint(resolved.oldKey),
        new_key_fp: keyFingerprint(resolved.newKey),
        counts: result.counts,
        sample: result.sample,
      },
      ipAddress: req.ip ?? null,
    });
    res.json({
      jobId,
      counts: result.counts,
      sample: result.sample,
      keyFingerprints: {
        old: keyFingerprint(resolved.oldKey),
        new: keyFingerprint(resolved.newKey),
      },
    });
  }),
);

intakeAdminRouter.post(
  '/rotate-key',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.session.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = rotateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const firm = await db('firm_settings')
      .where({ id: 1 })
      .first<{ intake_maintenance_mode: boolean }>('intake_maintenance_mode');
    if (!firm?.intake_maintenance_mode) {
      // Refuse to mutate at-rest data while public writes are still
      // accepted — a new POST /sessions mid-rotation would land under
      // the OLD key but be processed by the worker either before the
      // worker advances past it (re-encrypts to NEW, fine) or after
      // (worker misses it; row stays under OLD; subsequent reads with
      // NEW post-swap would fail). The maintenance gate eliminates
      // this race entirely.
      res.status(409).json({ error: 'maintenance_required' });
      return;
    }
    // Atomically claim the rotation slot BEFORE the worker dispatch.
    // Single-threaded Node ensures two concurrent POSTs cannot both
    // observe `false` here — one wins, the other 409s.
    if (!tryClaimRotationActive()) {
      res.status(409).json({ error: 'rotation_already_running' });
      return;
    }
    let resolved: { oldKey: Uint8Array; newKey: Uint8Array } | { error: string };
    let counts: Awaited<ReturnType<typeof countRotationTargets>>;
    let jobId: string;
    try {
      resolved = resolveRotationKeys(parsed.data);
      if ('error' in resolved) {
        releaseRotationActive();
        res.status(400).json({ error: resolved.error });
        return;
      }
      // Phase 28.16 — refuse to start rotation when the firm's per-file
      // cap exceeds what the streaming primitives can buffer. The
      // rotation worker allocates ~3× peak (oldCt + plaintext + newCt +
      // verify copy); Node's hard Buffer ceiling is ~4 GiB; we set a
      // safety floor well under that.
      const settings = await db('firm_settings')
        .where({ id: 1 })
        .first<{ intake_max_file_bytes: string | number }>('intake_max_file_bytes');
      const maxBytes = Number(settings?.intake_max_file_bytes ?? 50 * 1024 * 1024);
      if (maxBytes > ROTATION_MAX_FILE_BYTES) {
        releaseRotationActive();
        res.status(409).json({
          error: 'file_cap_too_high_for_rotation',
          detail: `firm_settings.intake_max_file_bytes=${maxBytes} exceeds rotation safe cap ${ROTATION_MAX_FILE_BYTES}. Lower the per-file cap before rotating.`,
        });
        return;
      }
      counts = await countRotationTargets();
      const rows = (await db('intake_key_rotations')
        .insert({
          status: 'running',
          total_sessions: counts.total_sessions,
          processed_sessions: 0,
          total_files: counts.total_files,
          processed_files: 0,
          total_pdfs: counts.total_pdfs,
          processed_pdfs: 0,
          started_by_user_id: req.session.userId!,
          dry_run: false,
        })
        .returning(['id'])) as Array<{ id: string }>;
      jobId = rows[0]!.id;
    } catch (err) {
      releaseRotationActive();
      throw err;
    }
    const resolvedKeys = resolved;
    // Fire-and-forget. Errors are persisted to intake_key_rotations.status
    // and audited; route handler doesn't await. The worker's `finally`
    // clears activeRotation on completion or failure.
    void runKeyRotation({
      jobId,
      oldKey: resolvedKeys.oldKey,
      newKey: resolvedKeys.newKey,
      batchSize: parsed.data.batchSize ?? 100,
    }).catch((err) => {
      logger.error('intake.key_rotation.unhandled', {
        jobId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    res.status(202).json({
      jobId,
      counts,
      keyFingerprints: {
        old: keyFingerprint(resolvedKeys.oldKey),
        new: keyFingerprint(resolvedKeys.newKey),
      },
    });
  }),
);

intakeAdminRouter.get(
  '/rotate-key/:jobId',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.session.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const row = await db('intake_key_rotations').where({ id: req.params.jobId }).first();
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({
      rotation: {
        id: row.id,
        status: row.status,
        dryRun: row.dry_run,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        totalSessions: row.total_sessions,
        processedSessions: row.processed_sessions,
        totalFiles: row.total_files,
        processedFiles: row.processed_files,
        totalPdfs: row.total_pdfs,
        processedPdfs: row.processed_pdfs,
        lastProcessedSessionId: row.last_processed_session_id,
        errorMessage: row.error_message,
        startedByUserId: row.started_by_user_id,
      },
    });
  }),
);

intakeAdminRouter.post(
  '/rotate-key/:jobId/resume',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.session.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = rotateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const firm = await db('firm_settings')
      .where({ id: 1 })
      .first<{ intake_maintenance_mode: boolean }>('intake_maintenance_mode');
    if (!firm?.intake_maintenance_mode) {
      res.status(409).json({ error: 'maintenance_required' });
      return;
    }
    // Atomic claim (same pattern as POST /rotate-key). Defends against
    // two operators racing /resume on the same paused job.
    if (!tryClaimRotationActive()) {
      res.status(409).json({ error: 'rotation_already_running' });
      return;
    }
    try {
      const job = await db('intake_key_rotations').where({ id: req.params.jobId }).first();
      if (!job) {
        releaseRotationActive();
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (job.status !== 'paused' && job.status !== 'failed') {
        releaseRotationActive();
        res.status(409).json({ error: 'not_resumable', status: job.status });
        return;
      }
      if (job.dry_run) {
        releaseRotationActive();
        res.status(400).json({ error: 'dry_run_not_resumable' });
        return;
      }
      const resolved = resolveRotationKeys(parsed.data);
      if ('error' in resolved) {
        releaseRotationActive();
        res.status(400).json({ error: resolved.error });
        return;
      }
      // Conditional UPDATE: only flip to 'running' when the row is
      // still in a resumable state. Knex's .update() returns the row
      // count; if 0 rows match, another resume already claimed it.
      const updated = (await db('intake_key_rotations')
        .where({ id: job.id })
        .whereIn('status', ['paused', 'failed'])
        .update({ status: 'running', error_message: null })) as number;
      if (updated !== 1) {
        releaseRotationActive();
        res.status(409).json({ error: 'rotation_already_running' });
        return;
      }
      void runKeyRotation({
        jobId: job.id,
        oldKey: resolved.oldKey,
        newKey: resolved.newKey,
        batchSize: parsed.data.batchSize ?? 100,
        resumeFromSessionId: job.last_processed_session_id,
      }).catch((err) => {
        logger.error('intake.key_rotation.unhandled', {
          jobId: job.id,
          err: err instanceof Error ? err.message : String(err),
        });
      });
      await auditRepo.write({
        actorUserId: req.session.userId ?? null,
        action: 'intake.key_rotation.resumed',
        targetType: 'intake_key_rotation',
        targetId: job.id,
        details: { resumeFromSessionId: job.last_processed_session_id },
        ipAddress: req.ip ?? null,
      });
      res.status(202).json({ jobId: job.id, resumedFrom: job.last_processed_session_id });
    } catch (err) {
      releaseRotationActive();
      throw err;
    }
  }),
);

// -------- maintenance mode --------
//
// Flips `firm_settings.intake_maintenance_mode`. The public-writes gate
// in apps/server/src/routes/intakePublic.ts reads this flag every request
// (cheap singleton query, no caching to avoid stale-read races during a
// rotation). RBAC: admin-only.

const maintenanceSchema = z.object({ enabled: z.boolean() }).strict();

intakeAdminRouter.post(
  '/maintenance',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.session.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = maintenanceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    // Phase 28.16 hardening — refuse to disable maintenance while a
    // rotation is in-flight. Both the in-process flag (covers the
    // common case) AND the DB row (covers cross-restart paused jobs)
    // are checked. Allowing a disable here re-opens public writes
    // while the worker is still mid-encrypt: new sessions would land
    // under the OLD key past the worker's `last_processed_session_id`
    // and become permanently unreadable after the operator swaps env
    // vars. The maintenance gate is the only barrier preventing this.
    if (!parsed.data.enabled) {
      if (isRotationActive()) {
        res.status(409).json({
          error: 'rotation_in_flight',
          detail: 'Cannot disable maintenance while a key rotation is running.',
        });
        return;
      }
      const liveJob = await db('intake_key_rotations')
        .whereIn('status', ['running', 'paused'])
        .where('dry_run', false)
        .first('id', 'status');
      if (liveJob) {
        res.status(409).json({
          error: 'rotation_in_flight',
          detail: `intake_key_rotations row ${liveJob.id} is ${liveJob.status}. Resume + complete or mark failed before re-opening intake.`,
        });
        return;
      }
    }
    await db('firm_settings')
      .where({ id: 1 })
      .update({ intake_maintenance_mode: parsed.data.enabled });
    await auditRepo.write({
      actorUserId: req.session.userId ?? null,
      action: 'intake.maintenance.toggled',
      targetType: 'firm_settings',
      targetId: '1',
      details: { enabled: parsed.data.enabled },
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true, enabled: parsed.data.enabled });
  }),
);
