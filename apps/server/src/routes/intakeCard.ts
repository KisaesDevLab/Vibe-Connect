// Phase 28.2 — Staff intake-card settings.
//
// Six routes split across two surfaces:
//
//   Self (any authenticated staff, edits own card):
//     GET    /users/me/intake-card
//     PATCH  /users/me/intake-card
//     POST   /users/me/intake-card/headshot
//
//   Admin (requires admin role):
//     GET    /admin/intake-cards
//     POST   /admin/intake-cards/reorder
//     GET    /admin/intake/status
//
// At-rest encryption for the headshot file is the same secretbox pattern
// as `routes/users.ts` avatars but with a distinct HKDF salt — rotating
// SESSION_SECRET invalidates both, but the two domains can never collide
// when somebody mounts a "swap an avatar for a headshot" attack against
// the on-disk store. The headshot serving route lives in `app.ts` and is
// PUBLIC (no auth) because Phase 28.3's anonymous `/intake` landing
// shows these to walk-up clients.
//
// CRYPTO: server-held secretbox key, NOT E2EE. Same posture as the avatar
// store — defense in depth for an exfiltrated disk image. Distinct from
// the Phase 28 intake content key (CONNECT_INTAKE_ENCRYPTION_KEY) which
// protects intake_sessions PII; the headshot is intentionally public-
// facing imagery and using the intake content key for it would create a
// surprising "rotating the intake key voids every staff headshot" coupling.
import nodeCrypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import { z } from 'zod';
import { secretboxDecrypt, secretboxEncrypt } from '@vibe-connect/crypto';
import { env } from '../env.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { auditRepo } from '../repositories/audit.js';
import { intakeCardsRepo } from '../repositories/intake.js';

// Two routers, mounted at distinct prefixes by app.ts:
//   intakeCardSelfRouter    /users/me/intake-card
//   intakeCardAdminRouter   /admin
//
// Split (rather than one router at `/` with absolute paths) so neither
// router straddles the same mount prefix as the broader users/admin routers.
// Means a future intakeCard route that happens to call next() falls through
// to nothing instead of into usersRouter / adminRouter, where the broader
// router's middleware (e.g. requireAdmin on adminRouter children) would run
// against intakeCard-shaped requests.
export const intakeCardSelfRouter = Router();
export const intakeCardAdminRouter = Router();

const INTAKE_HEADSHOT_DIR = path.resolve(env.attachmentLocalDir, 'intake-headshots');
await fs.mkdir(INTAKE_HEADSHOT_DIR, { recursive: true });

function intakeHeadshotKey(): Uint8Array {
  // Deterministic 32-byte key from SESSION_SECRET. Distinct salt from the
  // avatar key so the two on-disk stores can't be cross-decrypted.
  return new Uint8Array(
    nodeCrypto.hkdfSync(
      'sha256',
      env.sessionSecret,
      Buffer.alloc(0),
      'vibe-connect-intake-headshots',
      32,
    ),
  );
}

const intakeHeadshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB — matches avatar cap
  fileFilter: (_req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(null, ok);
  },
});

// 20 uploads/hour/user — mirrors the avatar rate limiter in users.ts. Without
// this, a single authenticated workstation can pin a sharp decode worker at
// full CPU per request (5MB input → 25 MP buffer × 600/min global cap is a
// trivial DoS). Combined with the limitInputPixels guard on sharp itself,
// the worst case stays bounded.
const intakeHeadshotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.session.userId ?? req.ip ?? 'anon',
});

const TITLE_MAX = 60;
const BIO_MAX = 280;

/**
 * Body schema for `PATCH /users/me/intake-card`. Every field is optional —
 * a single PATCH may flip just the toggle, or just the bio, etc. `null`
 * clears the field; `undefined` leaves it alone. Length caps are the
 * authoritative source of the constraint (the UI counter is advisory).
 */
const patchSelfSchema = z
  .object({
    showOnIntakeCard: z.boolean().optional(),
    bio: z.string().max(BIO_MAX).nullable().optional(),
    title: z.string().max(TITLE_MAX).nullable().optional(),
    // Phase 28.12 — per-staff notification preference. See
    // services/intakeStaffNotifyTicker.ts for routing semantics.
    notifyMode: z.enum(['realtime', 'digest', 'in_app_only']).optional(),
  })
  .strict();

// Self routes are mounted at /users/me/intake-card, so paths inside the
// router are relative ('/' = the base, '/headshot' = the upload sub-route).
intakeCardSelfRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const card = await intakeCardsRepo.getForUser(req.session.userId!);
    if (!card) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({
      showOnIntakeCard: card.show_on_intake_card,
      bio: card.intake_card_bio,
      title: card.intake_card_title,
      headshotUrl: card.intake_card_headshot_url,
      order: card.intake_card_order,
      notifyMode: card.intake_notify_mode,
    });
  }),
);

intakeCardSelfRouter.patch(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = patchSelfSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const userId = req.session.userId!;
    const patch: Partial<{
      show_on_intake_card: boolean;
      intake_card_bio: string | null;
      intake_card_title: string | null;
      intake_notify_mode: 'realtime' | 'digest' | 'in_app_only';
    }> = {};
    if (parsed.data.showOnIntakeCard !== undefined) {
      patch.show_on_intake_card = parsed.data.showOnIntakeCard;
    }
    if (parsed.data.bio !== undefined) {
      patch.intake_card_bio = parsed.data.bio;
    }
    if (parsed.data.title !== undefined) {
      patch.intake_card_title = parsed.data.title;
    }
    if (parsed.data.notifyMode !== undefined) {
      patch.intake_notify_mode = parsed.data.notifyMode;
    }
    const updated = await intakeCardsRepo.updateForUser(userId, patch);
    if (!updated) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // No-op PATCH (caller sent `{}` after .strict() parse, or every value
    // matched what was already on the row) shouldn't produce an audit
    // row — those events are meant to track *changes*. The Object.keys
    // check is the cheap-and-correct version: a truly idempotent PATCH
    // (sending the same value already on the row) still audits today, but
    // the spurious-empty case is the one the linter caught.
    if (Object.keys(patch).length > 0) {
      await auditRepo.write({
        actorUserId: userId,
        action: 'intake.card.updated',
        targetType: 'intake_card',
        targetId: userId,
        details: { fields: Object.keys(patch) },
        ipAddress: req.ip ?? null,
      });
    }
    res.json({
      showOnIntakeCard: updated.show_on_intake_card,
      bio: updated.intake_card_bio,
      title: updated.intake_card_title,
      headshotUrl: updated.intake_card_headshot_url,
      order: updated.intake_card_order,
      notifyMode: updated.intake_notify_mode,
    });
  }),
);

intakeCardSelfRouter.post(
  '/headshot',
  requireAuth,
  intakeHeadshotLimiter,
  intakeHeadshotUpload.single('headshot'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'no_file' });
      return;
    }
    const userId = req.session.userId!;
    // sharp resize to 400×400 webp, regardless of input format/dimensions.
    // `cover` crops to a square; quality 82 hits the visual sweet spot for
    // staff portraits at this size. Animated GIFs collapse to first frame —
    // intake cards are static portraits, not avatars-with-motion.
    //
    // `limitInputPixels` is the defense against image bombs: multer's 5 MB
    // ceiling caps the *encoded* size, but a 5 MB malicious WebP/PNG can
    // decompress to gigabytes of raw pixels. Sharp's default cap is 268 MP
    // which is hostile-grade; 25 MP (~6000×4000) is generous for a face
    // shot and well below memory-pressure thresholds on a 16 GB NUC.
    let processed: Buffer;
    try {
      processed = await sharp(req.file.buffer, { limitInputPixels: 25_000_000 })
        .resize({ width: 400, height: 400, fit: 'cover', position: 'attention' })
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
    } catch {
      // sharp throws on corrupt/unsupported input even when the multer MIME
      // filter said yes — a renamed `.txt` slips past MIME sniff in rare
      // edge cases — AND on limitInputPixels overrun. Return 400 with a
      // generic message rather than leaking sharp's internal error text.
      res.status(400).json({ error: 'image_decode_failed' });
      return;
    }
    const filename = `${userId}.webp.enc`;
    const fullPath = path.join(INTAKE_HEADSHOT_DIR, filename);
    const wrapped = await secretboxEncrypt(new Uint8Array(processed), intakeHeadshotKey());
    // secretboxEncrypt returns base64 (string). Write as utf8 to mirror the
    // avatar store; serveIntakeHeadshotFromDisk reads back the same way.
    await fs.writeFile(fullPath, wrapped, { encoding: 'utf8' });
    const headshotUrl = `/attachments/intake-headshots/${filename}`;
    await intakeCardsRepo.updateForUser(userId, { intake_card_headshot_url: headshotUrl });
    await auditRepo.write({
      actorUserId: userId,
      action: 'intake.card.headshot_updated',
      targetType: 'intake_card',
      targetId: userId,
      // Bytes only — never log the filename (would leak the predictable
      // `${userId}.webp.enc` form into the audit JSONB; userId is already
      // the targetId so the linkage is preserved without duplication).
      details: { bytes: processed.length },
      ipAddress: req.ip ?? null,
    });
    res.json({ headshotUrl });
  }),
);

/** Decryption helper for the public serving route in app.ts. */
export async function serveIntakeHeadshotFromDisk(filename: string): Promise<Buffer | null> {
  try {
    const fullPath = path.join(INTAKE_HEADSHOT_DIR, filename);
    const blob = await fs.readFile(fullPath, 'utf8');
    const plain = await secretboxDecrypt(blob, intakeHeadshotKey());
    return Buffer.from(plain);
  } catch {
    return null;
  }
}

// -------- Admin surface --------
// Mounted at /admin so the routes register as /admin/intake-cards,
// /admin/intake-cards/reorder, /admin/intake/status.

intakeCardAdminRouter.get(
  '/intake-cards',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await intakeCardsRepo.adminListing();
    res.json({
      cards: rows.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        isAdmin: r.is_admin,
        showOnIntakeCard: r.show_on_intake_card,
        order: r.intake_card_order,
        bio: r.intake_card_bio,
        title: r.intake_card_title,
        headshotUrl: r.intake_card_headshot_url,
      })),
    });
  }),
);

const reorderSchema = z.object({
  // Cap the batch size so a single POST can't sweep an arbitrarily large
  // user table. 1000 is well above any realistic firm staff count.
  items: z
    .array(
      z.object({
        userId: z.string().uuid(),
        // null clears the order (drops to "alphabetical fallback"); integer
        // 0..10000 is the explicit position.
        order: z.number().int().min(0).max(10_000).nullable(),
      }),
    )
    .min(1)
    .max(1000),
});

intakeCardAdminRouter.post(
  '/intake-cards/reorder',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = reorderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    // Repo throws `ReorderUnknownUsersError` when any item targets a userId
    // that does not exist or is deactivated. Surface that as a 400 so the
    // admin UI can show "these accounts were skipped" without invalidating
    // the rest of the batch on the server side (transaction rolls back).
    let result: { touched: number };
    try {
      result = await intakeCardsRepo.batchReorder(parsed.data.items);
    } catch (err) {
      if (err instanceof intakeCardsRepo.ReorderUnknownUsersError) {
        res.status(400).json({ error: 'unknown_or_inactive_users', missing: err.missing });
        return;
      }
      throw err;
    }
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'intake.card.order_changed',
      // Singular `intake_card` matches the migration's partial audit index
      // (idx_audit_log_intake). The order_changed event affects multiple
      // rows in one call, but the *target type* is still the intake-card
      // domain — using the plural form here would silently bypass the
      // index and slow audit queries.
      targetType: 'intake_card',
      targetId: null,
      details: { items: parsed.data.items.length, touched: result.touched },
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true, touched: result.touched });
  }),
);

intakeCardAdminRouter.get(
  '/intake/status',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const optedIn = await intakeCardsRepo.countOptedIn();
    res.json({ optedIn, configured: optedIn > 0 });
  }),
);
