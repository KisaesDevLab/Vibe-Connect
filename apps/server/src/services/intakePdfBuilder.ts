// Phase 28.9 — Server-side image-set → PDF assembler.
//
// Called by `intakePdfTicker.ts` once per pending `intake_pdfs` row.
// Returns the assembled PDF bytes + page count; the caller handles
// encrypt-and-store.
//
// Cover page: text-only Helvetica. Firm logo rendering is deliberately
// skipped in this MVP — `firm_settings.logo_url` is an admin-settable
// URL (could be on the appliance host, could be on a public CDN, could
// be an attacker-controlled hostname if the install flow ever gets
// compromised). Fetching it server-side opens an SSRF surface that's
// not worth the rendering polish. The firm NAME is included as text
// and the cover sheet reads cleanly without the logo.
//
// Scanned image pages: each scanned_image file is decrypted, normalised
// through sharp (handles HEIC, fixes EXIF orientation), and embedded as
// JPEG via pdf-lib's `embedJpg`. Each image gets its own A4 portrait
// page (595×842 PDF points) with aspect-ratio-preserving fit-to-page.
//
// Non-image (`kind='file'`) uploads are NOT embedded in the assembled
// PDF — they live alongside it as `intake_files` rows. The cover page
// lists their filenames + sizes so the staff recipient can correlate
// the PDF with the loose files in the session.
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  PDFDocument,
  StandardFonts,
  type PDFEmbeddedPage,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import {
  type IntakeFileRow,
  type IntakeSessionRow,
  intakeFilesRepo,
  intakeSessionsRepo,
} from '../repositories/intake.js';
import { attachmentStorage } from './attachmentStorage.js';
import { decryptBufferStreaming, decryptField } from './intakeCrypto.js';
import { autoDetectAndWarp, parseScannerMeta, warpAndEnhance } from './intakeScannerWarp.js';

// A4 portrait in PDF user units (1/72 inch). 595×842 = 210×297mm.
const A4_W = 595;
const A4_H = 842;

const COVER_MARGIN = 50;
const COVER_TITLE_SIZE = 18;
const COVER_LABEL_SIZE = 9;
const COVER_VALUE_SIZE = 11;
const COVER_LINE_GAP = 6;

export interface BuildPdfResult {
  pdfBytes: Uint8Array;
  pageCount: number;
  /** sha256 of the assembled PDF bytes — caller stores this on the
   *  `intake_pdfs` row so the staff "verify checksum" path works. */
  sha256: string;
}

/**
 * Build the assembled PDF for one intake session. Reads everything the
 * cover page needs + the scanned images; returns bytes to the caller
 * (the ticker encrypts + stores).
 *
 * Throws when:
 *   - The session is missing (shouldn't happen — caller filters by FK)
 *   - Decrypting any PII column fails (intake key mismatch / corrupted
 *     bytea — this is the "data loss" case the operator escalation path
 *     in the ticker is for)
 *   - sharp rejects an image (corrupted blob on disk) — but only after
 *     skipping it; the conversion completes with the remaining pages
 */
export async function buildPdfForSession(sessionId: string): Promise<BuildPdfResult> {
  const session = await intakeSessionsRepo.byId(sessionId);
  if (!session) {
    throw new Error(`buildPdfForSession: session ${sessionId} not found`);
  }
  const files = await intakeFilesRepo.listBySession(sessionId);
  // Every image-mime upload becomes an embedded PDF page, regardless of
  // whether it arrived through the in-browser scanner (kind='scanned_image')
  // or through the regular file picker / iOS native-camera fallback
  // (kind='file' with an image/* mime). Originally we only embedded
  // kind='scanned_image' rows, which left clients-who-took-a-photo with a
  // cover-only PDF and their image listed in "Other files attached" —
  // surprising for the staff recipient who expected one mergeable PDF.
  const isEmbeddable = (f: IntakeFileRow): boolean =>
    f.kind === 'scanned_image' || (f.mime_type ?? '').toLowerCase().startsWith('image/');
  const scannedImages = files.filter(isEmbeddable);
  const otherFiles = files.filter((f) => !isEmbeddable(f));

  const staff = await db('users')
    .where({ id: session.staff_id })
    .first<
      { display_name: string; intake_card_title: string | null } | undefined
    >('display_name', 'intake_card_title');
  const firm = await db('firm_settings').where({ id: 1 }).first<{
    firm_name: string;
    intake_include_cover_page: boolean;
  }>('firm_name', 'intake_include_cover_page');

  // PII decryption for the cover page. Throwing here is intentional —
  // the ticker catches and retries; permanent failure after 3 attempts
  // surfaces to the admin via the 28.12 notification path.
  const clientName = await decryptField(session.client_name_enc);
  const clientEmail = session.client_email_enc
    ? await decryptField(session.client_email_enc)
    : null;
  const clientPhone = session.client_phone_enc
    ? await decryptField(session.client_phone_enc)
    : null;
  // Optional client-typed note. Decrypt failures fall back to null so a
  // mangled blob doesn't poison the whole cover-page render.
  const clientMessage = session.client_message_enc
    ? await decryptField(session.client_message_enc).catch(() => null)
    : null;

  const pdfDoc = await PDFDocument.create();
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  if (firm.intake_include_cover_page) {
    addCoverPage(pdfDoc, helv, helvBold, {
      firmName: firm.firm_name || 'Firm',
      clientName,
      clientEmail,
      clientPhone,
      clientMessage,
      finalizedAt: session.finalized_at ?? session.created_at,
      staffName: staff?.display_name ?? '(unknown staff)',
      staffTitle: staff?.intake_card_title ?? null,
      source: session.source === 'staff_link' ? 'Direct link' : 'Public intake page',
      scannedImages,
      otherFiles,
      sessionId: session.id,
    });
  }

  // Embed each scanned image. If a particular image fails to decrypt or
  // sharp rejects it, we log + skip rather than aborting the whole job —
  // a single bad blob shouldn't lose the rest of the session.
  for (const img of scannedImages) {
    try {
      const ct = await attachmentStorage().get(img.stored_path);
      const plain = await decryptBufferStreaming(ct);
      // Three paths converge here, in priority order:
      //
      //   1. Rows with client-supplied `scanner_meta` (legacy, pre-
      //      v0.4.29 — the client review/crop step that's since been
      //      removed for the iOS hang it caused). Use the corners the
      //      user placed.
      //   2. Rows from the v0.4.29+ flow (no scanner_meta) — try the
      //      server-side detector. If it finds a confident document
      //      region, warp + enhance with the detected quad.
      //   3. Anything else (OS-native camera passthroughs, low-contrast
      //      photos the detector bailed on, errors anywhere upstream)
      //      — embed the EXIF-rotated photo as-is. User still gets
      //      their content in the PDF, just un-cropped.
      //
      // Every layer falls forward on its own error: a degenerate quad,
      // a sharp decode failure, or an OOM in the warp pass should not
      // drop the whole page from the PDF.
      let jpeg: Buffer;
      const meta = parseScannerMeta(img.scanner_meta);
      if (meta) {
        try {
          const out = await warpAndEnhance(plain, meta);
          jpeg = out.jpeg;
        } catch (warpErr) {
          logger.warn('intake.pdf_warp_failed_fallback', {
            sessionId,
            fileId: img.id,
            msg: warpErr instanceof Error ? warpErr.message : String(warpErr),
          });
          jpeg = await sharp(plain).rotate().jpeg({ quality: 85 }).toBuffer();
        }
      } else {
        let detected: Awaited<ReturnType<typeof autoDetectAndWarp>> = null;
        try {
          detected = await autoDetectAndWarp(plain);
        } catch (detectErr) {
          // Detector throws are non-fatal — the photo still goes into
          // the PDF un-cropped. Log so an operator can see a pattern
          // if it starts failing on every page.
          logger.warn('intake.pdf_detect_failed_fallback', {
            sessionId,
            fileId: img.id,
            msg: detectErr instanceof Error ? detectErr.message : String(detectErr),
          });
        }
        jpeg = detected
          ? detected.jpeg
          : await sharp(plain).rotate().jpeg({ quality: 85 }).toBuffer();
      }
      const embedded = await pdfDoc.embedJpg(jpeg);
      addImagePage(pdfDoc, embedded);
    } catch (err) {
      logger.warn('intake.pdf_image_skipped', {
        sessionId,
        fileId: img.id,
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Zero pages would produce an invalid PDF — pdf-lib requires at least
  // one. The cover-page-only path covers this; if `intake_include_cover_page`
  // is false AND there are zero scanned images, fall back to a single
  // text page documenting the empty scan set.
  if (pdfDoc.getPageCount() === 0) {
    addCoverPage(pdfDoc, helv, helvBold, {
      firmName: firm.firm_name || 'Firm',
      clientName,
      clientEmail,
      clientPhone,
      clientMessage,
      finalizedAt: session.finalized_at ?? session.created_at,
      staffName: staff?.display_name ?? '(unknown staff)',
      staffTitle: staff?.intake_card_title ?? null,
      source: session.source === 'staff_link' ? 'Direct link' : 'Public intake page',
      scannedImages,
      otherFiles,
      sessionId: session.id,
    });
  }

  const bytes = await pdfDoc.save();
  return {
    pdfBytes: bytes,
    pageCount: pdfDoc.getPageCount(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

interface CoverFields {
  firmName: string;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  clientMessage: string | null;
  finalizedAt: string;
  staffName: string;
  staffTitle: string | null;
  source: string;
  scannedImages: IntakeFileRow[];
  otherFiles: IntakeFileRow[];
  sessionId: string;
}

function addCoverPage(
  pdfDoc: PDFDocument,
  helv: PDFFont,
  helvBold: PDFFont,
  fields: CoverFields,
): void {
  const page = pdfDoc.addPage([A4_W, A4_H]);

  // Header: firm name (large, bold) + page title (smaller, regular).
  let y = A4_H - COVER_MARGIN;
  page.drawText(fields.firmName, {
    x: COVER_MARGIN,
    y: y - 14,
    size: 14,
    font: helvBold,
  });
  y -= 20;
  page.drawText('Document Intake Cover Sheet', {
    x: COVER_MARGIN,
    y: y - COVER_TITLE_SIZE,
    size: COVER_TITLE_SIZE,
    font: helvBold,
  });
  y -= COVER_TITLE_SIZE + 16;

  // Rule under the header.
  page.drawLine({
    start: { x: COVER_MARGIN, y },
    end: { x: A4_W - COVER_MARGIN, y },
    thickness: 0.5,
  });
  y -= 16;

  // Two-column layout for the field block: labels left-aligned at the
  // margin, values indented. Keeps the cover legible at print size.
  const drawField = (label: string, value: string): void => {
    page.drawText(label.toUpperCase(), {
      x: COVER_MARGIN,
      y: y - COVER_LABEL_SIZE,
      size: COVER_LABEL_SIZE,
      font: helvBold,
    });
    y -= COVER_LABEL_SIZE + 2;
    // Wrap long values at ~76 chars so phone+email don't run past the
    // right margin. pdf-lib doesn't ship a word-wrap helper.
    for (const line of wrap(value, 76)) {
      page.drawText(line, {
        x: COVER_MARGIN,
        y: y - COVER_VALUE_SIZE,
        size: COVER_VALUE_SIZE,
        font: helv,
      });
      y -= COVER_VALUE_SIZE + 2;
    }
    y -= COVER_LINE_GAP;
  };

  drawField('From', fields.clientName);
  const contactParts = [fields.clientEmail, fields.clientPhone].filter(Boolean) as string[];
  drawField('Contact', contactParts.length > 0 ? contactParts.join('  ·  ') : '(none provided)');
  drawField('Submitted', formatDate(fields.finalizedAt));
  drawField(
    'Received by',
    fields.staffTitle ? `${fields.staffName} — ${fields.staffTitle}` : fields.staffName,
  );
  drawField('Source', fields.source);

  // Submission reference — 8-char prefix of sha256(session_id). Plenty
  // unique for cross-referencing in support tickets without leaking the
  // whole id (which carries the upload-token JTI by extension).
  const ref = createHash('sha256').update(fields.sessionId).digest('hex').slice(0, 8);
  drawField('Submission reference', ref);

  // Client-typed message. Rendered above the manifests so the staff
  // recipient reads the note before scanning file lists. Falls back to
  // skipping the section entirely when empty — no "(none)" placeholder,
  // since the field is optional and an absent note isn't a meaningful
  // signal.
  if (fields.clientMessage && fields.clientMessage.trim()) {
    y -= 4;
    page.drawText('Message from client', {
      x: COVER_MARGIN,
      y: y - COVER_LABEL_SIZE,
      size: COVER_LABEL_SIZE,
      font: helvBold,
    });
    y -= COVER_LABEL_SIZE + 4;
    // Wrap user-entered text. Honour intentional newlines (a client who
    // typed "Item 1\nItem 2" should see them as separate lines) and
    // word-wrap each segment at the same width used for field values.
    for (const segment of fields.clientMessage.replace(/\r\n/g, '\n').split('\n')) {
      const lines = segment.length === 0 ? [''] : wrap(segment, 86);
      for (const line of lines) {
        if (y < COVER_MARGIN + 80) {
          // Stop before colliding with the file manifests. The full
          // message is still available in the staff detail view; the
          // cover page is a summary surface.
          page.drawText('…', {
            x: COVER_MARGIN,
            y: y - 10,
            size: 10,
            font: helv,
          });
          y -= 14;
          break;
        }
        page.drawText(line, {
          x: COVER_MARGIN,
          y: y - 10,
          size: 10,
          font: helv,
        });
        y -= 14;
      }
      if (y < COVER_MARGIN + 80) break;
    }
    y -= COVER_LINE_GAP;
  }

  // Scanned-pages manifest.
  y -= 8;
  page.drawText('Scanned pages included', {
    x: COVER_MARGIN,
    y: y - COVER_LABEL_SIZE,
    size: COVER_LABEL_SIZE,
    font: helvBold,
  });
  y -= COVER_LABEL_SIZE + 6;
  if (fields.scannedImages.length === 0) {
    page.drawText('(none)', {
      x: COVER_MARGIN,
      y: y - 10,
      size: 10,
      font: helv,
    });
    y -= 14;
  } else {
    for (let i = 0; i < fields.scannedImages.length; i++) {
      const f = fields.scannedImages[i]!;
      const text = `${String(i + 1).padStart(2, '0')}.  ${truncate(f.original_filename, 60)}  (${formatBytes(Number(f.size_bytes))})`;
      page.drawText(text, {
        x: COVER_MARGIN + 8,
        y: y - 10,
        size: 10,
        font: helv,
      });
      y -= 14;
      if (y < COVER_MARGIN + 40) break; // Stop overflowing the cover page.
    }
  }

  // Additional-files list.
  y -= 8;
  page.drawText('Other files attached', {
    x: COVER_MARGIN,
    y: y - COVER_LABEL_SIZE,
    size: COVER_LABEL_SIZE,
    font: helvBold,
  });
  y -= COVER_LABEL_SIZE + 6;
  if (fields.otherFiles.length === 0) {
    page.drawText('(none)', {
      x: COVER_MARGIN,
      y: y - 10,
      size: 10,
      font: helv,
    });
  } else {
    for (let i = 0; i < fields.otherFiles.length; i++) {
      const f = fields.otherFiles[i]!;
      const text = `•  ${truncate(f.original_filename, 60)}  (${formatBytes(Number(f.size_bytes))})`;
      page.drawText(text, {
        x: COVER_MARGIN + 8,
        y: y - 10,
        size: 10,
        font: helv,
      });
      y -= 14;
      if (y < COVER_MARGIN + 30) break;
    }
  }
}

/**
 * Draw `image` as one A4 portrait page, fit-to-page with aspect-ratio
 * preserved + zero margin. The build plan calls for this exact shape so
 * the produced PDF reads like a scanned document binder.
 */
function addImagePage(pdfDoc: PDFDocument, image: PDFImage | PDFEmbeddedPage): void {
  const page = pdfDoc.addPage([A4_W, A4_H]);
  const imgW = 'width' in image ? image.width : A4_W;
  const imgH = 'height' in image ? image.height : A4_H;
  const scale = Math.min(A4_W / imgW, A4_H / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const x = (A4_W - drawW) / 2;
  const y = (A4_H - drawH) / 2;
  page.drawImage(image as PDFImage, { x, y, width: drawW, height: drawH });
}

function wrap(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  } catch {
    return iso;
  }
}

// Test-only: expose IntakeSessionRow so the conversion-ticker tests can
// type-narrow without re-importing the repo types.
export type { IntakeSessionRow };

// pdf-lib's PDFPage type — re-exported for any caller that wants to
// post-process the cover after assembly (e.g. stamping a watermark in
// 28.17 polish). No production caller uses this today.
export type { PDFPage };
