// Phase 28.3+28.4 — Public, unauthenticated intake endpoints.
//
// Anonymous walk-up clients land on /intake in the apps/intake SPA, which
// fetches the opted-in staff card list from here AND posts the intake
// form (28.4) here. The endpoints in this router NEVER require auth —
// both by route definition and by mount position in app.ts (must be
// mounted ABOVE requestsRouter, which applies a blanket requireAuth via
// `.use()` and would otherwise intercept).
//
// CRYPTO / PRIVACY:
// - The /staff projection sent to anonymous visitors is locked at
//   intakeCardsRepo.publicListing — id, display_name, title, bio,
//   headshot_url, order. Adding any field to that projection without an
//   audit pass risks leaking organisational structure (email, role,
//   last-seen times). Re-read intake.ts before changing.
// - POST /sessions encrypts every client-supplied PII field (name, email,
//   phone) via intakeCrypto BEFORE the row hits the DB. The audit row
//   carries hashed IP + hashed UA, never plaintext.
// - Headshot URLs point at /attachments/intake-headshots/:name which is
//   already a public route (see app.ts) — no auth dance needed here.
import { randomBytes } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { auditRepo } from '../repositories/audit.js';
import {
  intakeCardsRepo,
  intakeFilesRepo,
  intakeNotificationsRepo,
  intakePdfsRepo,
  intakeSessionsRepo,
  type PublicIntakeCard,
} from '../repositories/intake.js';
import {
  decryptField,
  encryptField,
  hashForAudit,
  searchHash,
} from '../services/intakeCrypto.js';
import { signUploadToken, verifyUploadToken } from '../services/intakeUploadToken.js';

export const intakePublicRouter = Router();

// In-memory cache for the staff listing. The /intake landing page is loaded
// once per walk-up visitor — a 60s cache covers most card-grid renders on
// the same firm without round-tripping to Postgres. Invalidation: staff
// edits propagate within one TTL, which matches the Phase 28.2 acceptance
// criterion ("changes appear within one cache TTL").
//
// Why in-memory not Redis: Connect has no Redis (CLAUDE.md "Redis — only
// introduced if the TextLink bridge poller demands it"). A single-process
// cache is fine because the firm's appliance runs one app container; if a
// future multi-instance deployment ships, swap this for postgres LISTEN/NOTIFY
// invalidation rather than introducing Redis. Per-process duplication of
// the cache across replicas costs <1 KB per replica even with hundreds of
// staff — irrelevant.
const STAFF_CACHE_TTL_MS = 60_000;
interface StaffCacheEntry {
  expiresAt: number;
  payload: { staff: PublicIntakeCard[] };
}
let staffCache: StaffCacheEntry | null = null;

/**
 * Test-only invalidation. The public staff endpoint caches for 60 s by
 * design, but Vitest fixtures that mutate `users.show_on_intake_card`
 * between cases need a way to force a re-read without sleeping. Not
 * exported anywhere production code can reach it.
 */
export function __resetIntakeStaffCache(): void {
  staffCache = null;
}

intakePublicRouter.get(
  '/staff',
  asyncHandler(async (_req, res) => {
    const now = Date.now();
    if (staffCache && staffCache.expiresAt > now) {
      // Cache hit. The Cache-Control header lets browsers + any edge proxy
      // hold the response for the same TTL window — but the server caches
      // independently because the in-process map dominates the actual
      // serving cost (cache hit ratio at the edge will vary by deployment).
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
      res.json(staffCache.payload);
      return;
    }
    const rows = await intakeCardsRepo.publicListing();
    const payload = { staff: rows };
    staffCache = { expiresAt: now + STAFF_CACHE_TTL_MS, payload };
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json(payload);
  }),
);

// -------- Phase 28.14 — GET /links/:token (tokenized link resolve) --------
//
// Anonymous read of a tokenized intake link. The recipient lands at
// /intake/t/<token> in the apps/intake SPA, which immediately resolves
// the token here to render the assigned staff card + optional note +
// prefilled contact fields. We do NOT mutate the link on resolution —
// 28.13's use_count is bumped only when a session created via this link
// finalizes (see /sessions/:id/finalize below). Repeated GETs are
// idempotent so a back-button / refresh doesn't inflate the counter.
//
// Error shape mirrors RFC semantics: 404 for unknown, 410 for "the link
// existed but is now gone" (revoked or expired). The SPA renders the
// same terminal message for either 410 path; the distinction matters
// for the audit row.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Helper for the failure paths below. Writes an `intake.token.rejected`
 * audit row with the structured reason so the 28.17 audit viewer can
 * surface "100 expired tokens this week" without correlating IPs to
 * intake_links ids. `targetId` is the link id when known, null on
 * unknown/bad-shape tokens (we never persist the raw token in audit).
 */
async function auditTokenRejected(
  req: Request,
  reason: 'bad_shape' | 'not_found' | 'revoked' | 'expired' | 'staff_unavailable',
  linkId: string | null,
): Promise<void> {
  await auditRepo.write({
    actorUserId: null,
    action: 'intake.token.rejected',
    targetType: 'intake_link',
    targetId: linkId,
    details: {
      reason,
      hashed_ip: req.ip ? hashForAudit(req.ip) : null,
      ua_hash: req.headers['user-agent']
        ? hashForAudit(String(req.headers['user-agent']))
        : null,
    },
    ipAddress: req.ip ?? null,
  });
}

intakePublicRouter.get(
  '/links/:token',
  asyncHandler(async (req, res) => {
    const token = req.params.token ?? '';
    // Validate shape BEFORE the DB query so an attacker probing with
    // arbitrary garbage doesn't hit a token-lookup index path. We still
    // emit `intake.token.rejected` so probing campaigns are observable
    // in the audit viewer.
    if (!TOKEN_PATTERN.test(token)) {
      await auditTokenRejected(req, 'bad_shape', null);
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const link = await db('intake_links')
      .where({ token })
      .first<{
        id: string;
        assigned_staff_id: string;
        expires_at: string;
        revoked_at: string | null;
        client_email_enc: Buffer | null;
        client_phone_enc: Buffer | null;
        note_to_client: string | null;
      }>();
    if (!link) {
      await auditTokenRejected(req, 'not_found', null);
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (link.revoked_at) {
      await auditTokenRejected(req, 'revoked', link.id);
      res.status(410).json({ error: 'revoked' });
      return;
    }
    if (new Date(link.expires_at).getTime() <= Date.now()) {
      await auditTokenRejected(req, 'expired', link.id);
      res.status(410).json({ error: 'expired' });
      return;
    }
    // Staff projection is intentionally the same shape `/staff` returns
    // for the public landing — same auth boundary, same fields. If the
    // staff member has opted OUT of the public card grid the link is
    // still valid (they were directly chosen by another staff member),
    // but render with whatever card data the user row carries.
    const staff = await db('users')
      .where({ id: link.assigned_staff_id, is_active: true })
      .first<{
        id: string;
        display_name: string;
        title: string | null;
        bio: string | null;
        headshot_url: string | null;
      }>([
        'id',
        'display_name',
        { title: 'intake_card_title' },
        { bio: 'intake_card_bio' },
        { headshot_url: 'intake_card_headshot_url' },
      ]);
    if (!staff) {
      // Staff deactivated since link issuance. The link itself is fine
      // but the assignee is gone — render as expired so the recipient
      // contacts the firm rather than dropping files into a void.
      await auditTokenRejected(req, 'staff_unavailable', link.id);
      res.status(410).json({ error: 'staff_unavailable' });
      return;
    }

    // Decrypt the optional prefill. If the bytea is corrupt (e.g. mid-
    // rotation) we just send null and let the recipient retype — better
    // than a 500 here.
    const prefillEmail = link.client_email_enc
      ? await decryptField(link.client_email_enc).catch(() => null)
      : null;
    const prefillPhone = link.client_phone_enc
      ? await decryptField(link.client_phone_enc).catch(() => null)
      : null;

    await auditRepo.write({
      actorUserId: null,
      action: 'intake.token.validated',
      targetType: 'intake_link',
      targetId: link.id,
      details: {
        hashed_ip: req.ip ? hashForAudit(req.ip) : null,
        ua_hash: req.headers['user-agent']
          ? hashForAudit(String(req.headers['user-agent']))
          : null,
      },
      ipAddress: req.ip ?? null,
    });

    res.json({
      linkId: link.id,
      staff: {
        id: staff.id,
        display_name: staff.display_name,
        title: staff.title,
        bio: staff.bio,
        headshot_url: staff.headshot_url,
      },
      note: link.note_to_client,
      prefillEmail,
      prefillPhone,
      expiresAt: link.expires_at,
    });
  }),
);

// -------- Phase 28.16 — Maintenance-mode gate --------
//
// While `firm_settings.intake_maintenance_mode = true` (e.g. during a
// key rotation), public writes are refused with 503. Reads (GET /staff,
// GET /links/:token) stay live so operators can confirm the appliance
// is reachable. We deliberately query firm_settings on EVERY write
// rather than cache the flag — the rotation route flips it via PATCH
// and the next request must see the new value with no TTL window.
async function requireIntakeWritesEnabled(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const row = await db('firm_settings')
    .where({ id: 1 })
    .first<{ intake_maintenance_mode: boolean }>('intake_maintenance_mode');
  if (row?.intake_maintenance_mode) {
    res.status(503).json({ error: 'maintenance' });
    return;
  }
  next();
}

// -------- Phase 28.4 — POST /sessions (anonymous intake form submit) --------

// Sliding-window rate limit: 5 session creations per IP per 15 min. The
// global limiter at app.ts already caps requests/min/IP, but this endpoint
// has higher-cost side effects (DB insert, audit row, JWT mint, optional
// Turnstile round-trip), and the abuse pattern is one IP hammering the
// form to spam staff inboxes. We key on IP (not session — there isn't
// one yet) collapsed through the same ipBucket logic at the global tier,
// here approximated by express-rate-limit's default which already collapses
// IPv6 to a stable bucket.
const sessionCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.rateLimitIntakeSessionPer15Min,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

// Cap-the-body sizes match the Phase 28.4 build plan + the
// intake_card_title/bio caps used elsewhere (60/280). Name limit is the
// "120 char" line in §28.4.
const NAME_MAX = 120;

const sessionCreateSchema = z
  .object({
    // Exactly one of staffId / linkToken is required (refine below).
    // staffId = public flow (28.4); linkToken = tokenized flow (28.14).
    staffId: z.string().uuid().optional(),
    linkToken: z.string().regex(TOKEN_PATTERN).optional(),
    name: z.string().min(1).max(NAME_MAX).transform((s) => s.trim()),
    // Email + phone are both optional. For the public flow the post-parse
    // refine still requires at least one. For tokenized links the link's
    // own stored contact is used as a fallback when neither is supplied.
    // RFC 5322 is what zod.email() implements.
    email: z
      .string()
      .email()
      .max(255)
      .optional()
      .transform((s) => (s ? s.trim().toLowerCase() : undefined)),
    // Permissive — UI / app code normalises before posting. We require a
    // string of plausible-phone shape (digits, +, spaces, parens, dashes)
    // and then normalize server-side. libphonenumber would be overkill;
    // CPA-firm clients overwhelmingly use US numbers, and the contract
    // is "store something a human can paste back into a phone app", not
    // "guarantee dialable".
    phone: z
      .string()
      .min(7)
      .max(32)
      .regex(/^[\d\s+()\-.]+$/, 'phone_format')
      .optional(),
    turnstileToken: z.string().max(4096).optional(),
  })
  .strict()
  .refine((d) => Boolean(d.staffId) !== Boolean(d.linkToken), {
    message: 'route_required',
    path: ['staffId'],
  });

// Per-token in-memory sliding-window counter: 10 sessions per token per
// hour. Defends against link sharing/abuse without needing Redis. Lives
// in-process so a restart resets the counter — that's acceptable for
// the threat model (the limiter exists to deter, not to enforce a billing
// quota). Bucket entries auto-evict when the window slides past them.
const LINK_SESSIONS_PER_HOUR = 10;
const tokenSessionBuckets = new Map<string, number[]>();
function checkAndRecordTokenUse(tokenId: string): boolean {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const bucket = tokenSessionBuckets.get(tokenId) ?? [];
  const recent = bucket.filter((t) => t > cutoff);
  if (recent.length >= LINK_SESSIONS_PER_HOUR) {
    tokenSessionBuckets.set(tokenId, recent);
    return false;
  }
  recent.push(now);
  tokenSessionBuckets.set(tokenId, recent);
  return true;
}
export function __resetIntakeLinkBuckets(): void {
  tokenSessionBuckets.clear();
}

/**
 * Normalise a permissive phone input to E.164 best-effort. CPA-firm clients
 * almost universally type US numbers as `(555) 123-4567`, `555-123-4567`,
 * or `+1 555 123 4567`. We strip every non-digit and prepend `+1` when the
 * stripped digits look like a US local (10 chars). Anything else passes
 * through with a `+` prefix if it doesn't already have one.
 *
 * NOT a substitute for libphonenumber. Documented as a best-effort
 * normaliser; staff see whatever was stored, and the audit row carries a
 * search hash of the normalised form so future-staff searches against
 * "555-1234" and "+15551234567" land on the same bucket.
 */
function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // Anything else: if the original already starts with +, keep that;
  // otherwise prepend + to the cleaned digits.
  return raw.startsWith('+') ? `+${digits}` : `+${digits}`;
}

/**
 * Verify a Turnstile token against Cloudflare's siteverify endpoint. Returns
 * `true` when Turnstile is unconfigured (gracefully disabled) or the token
 * validates; `false` when configured-and-failed. Network-level failure
 * (timeout, bad-response) is treated as a Turnstile failure — fail closed
 * so a misconfigured siteverify URL can't be used as a bypass.
 */
async function verifyTurnstile(
  token: string | undefined,
  clientIp: string | null,
): Promise<boolean> {
  if (!env.turnstileSiteKey || !env.turnstileSecretKey) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({
      secret: env.turnstileSecretKey,
      response: token,
    });
    if (clientIp) body.set('remoteip', clientIp);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    try {
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body,
        signal: ctrl.signal,
      });
      if (!r.ok) return false;
      const data = (await r.json()) as { success?: boolean };
      return data.success === true;
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    logger.warn('intake.turnstile_verify_failed', {
      msg: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

intakePublicRouter.post(
  '/sessions',
  requireIntakeWritesEnabled,
  sessionCreateLimiter,
  asyncHandler(async (req, res) => {
    const parsed = sessionCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      // Surface the first error code path so the SPA can show the
      // appropriate inline message. The xor-refine surfaces with
      // path:['staffId'] message:'route_required' when both or neither
      // are present.
      const flat = parsed.error.flatten();
      const fieldErrors = flat.fieldErrors;
      const isRoute =
        fieldErrors.staffId?.includes('route_required') ||
        fieldErrors.linkToken?.includes('route_required');
      res.status(400).json({
        error: isRoute ? 'route_required' : 'bad_request',
        details: flat,
      });
      return;
    }
    const data = parsed.data;

    // Resolve the route: either a tokenized link or a public staff card.
    // Both paths converge on `effectiveStaffId` + `tokenId` (null for
    // public) which feed the session insert.
    let effectiveStaffId: string;
    let tokenId: string | null = null;
    let linkEmailPrefill: string | null = null;
    let linkPhonePrefill: string | null = null;
    const source: 'public' | 'staff_link' = data.linkToken ? 'staff_link' : 'public';

    if (data.linkToken) {
      const link = await db('intake_links')
        .where({ token: data.linkToken })
        .first<{
          id: string;
          assigned_staff_id: string;
          expires_at: string;
          revoked_at: string | null;
          client_email_enc: Buffer | null;
          client_phone_enc: Buffer | null;
        }>();
      if (!link) {
        res.status(404).json({ error: 'link_not_found' });
        return;
      }
      if (link.revoked_at) {
        res.status(410).json({ error: 'link_revoked' });
        return;
      }
      if (new Date(link.expires_at).getTime() <= Date.now()) {
        res.status(410).json({ error: 'link_expired' });
        return;
      }
      // Per-token sliding-window: 10 sessions / hour. Defends against a
      // single link being abused.
      if (!checkAndRecordTokenUse(link.id)) {
        res.status(429).json({ error: 'link_rate_limited' });
        return;
      }
      const staffOk = await db('users')
        .where({ id: link.assigned_staff_id, is_active: true })
        .first('id');
      if (!staffOk) {
        res.status(410).json({ error: 'staff_unavailable' });
        return;
      }
      effectiveStaffId = link.assigned_staff_id;
      tokenId = link.id;
      linkEmailPrefill = link.client_email_enc
        ? await decryptField(link.client_email_enc).catch(() => null)
        : null;
      linkPhonePrefill = link.client_phone_enc
        ? await decryptField(link.client_phone_enc).catch(() => null)
        : null;
    } else {
      // Public flow — staffId must exist, be active, and be opted in.
      // We don't expose the distinction (404 vs "not opted in") — both
      // collapse to a generic 400 so an attacker probing staff_ids can't
      // enumerate the staff table by status.
      const staff = await db('users')
        .where({ id: data.staffId, is_active: true, show_on_intake_card: true })
        .first('id');
      if (!staff) {
        res.status(400).json({ error: 'unknown_staff' });
        return;
      }
      effectiveStaffId = data.staffId!;
    }

    // Turnstile is only required on the public path; the tokenized path
    // uses the per-recipient secret as the unforgeable handle plus the
    // per-token rate limit above. Drive-by spam can't reach the
    // tokenized form without a real token.
    let turnstilePassed = true;
    if (source === 'public') {
      turnstilePassed = await verifyTurnstile(data.turnstileToken, req.ip ?? null);
      if (!turnstilePassed) {
        res.status(400).json({ error: 'turnstile_failed' });
        return;
      }
    }

    // Resolve effective contact: client overrides win; otherwise fall
    // back to whatever the link carried. At least one must be present
    // after resolution (DB constraint chk_intake_sessions_contact_present
    // enforces this too, but we want a clean 400 not a 500).
    const effectiveEmail = data.email ?? linkEmailPrefill ?? undefined;
    const effectivePhoneRaw = data.phone ?? linkPhonePrefill ?? undefined;
    if (!effectiveEmail && !effectivePhoneRaw) {
      res.status(400).json({ error: 'contact_required' });
      return;
    }
    // Re-validate the link-supplied phone: it was written under intakeAdmin's
    // schema which uses the same regex, but defence-in-depth + a corrupted
    // bytea wouldn't pass that regex anyway. Normalize the same way.
    const normalisedPhone = effectivePhoneRaw ? normalisePhone(effectivePhoneRaw) : undefined;
    const contactMethod: 'email' | 'sms' | 'both' =
      effectiveEmail && normalisedPhone ? 'both' : effectiveEmail ? 'email' : 'sms';

    // PII encryption happens here, before the row hits the DB. The audit
    // row that follows carries only hashes — never these values in plain.
    const nameEnc = await encryptField(data.name);
    const emailEnc = effectiveEmail ? await encryptField(effectiveEmail) : null;
    const phoneEnc = normalisedPhone ? await encryptField(normalisedPhone) : null;

    // Deterministic hashes for staff search (Phase 28.11). HKDF subkey,
    // independent of the intake content key — survives 28.16 rotation.
    const nameLowerHash = searchHash(data.name.toLowerCase());
    const emailHash = effectiveEmail ? searchHash(effectiveEmail) : null;
    const phoneHash = normalisedPhone ? searchHash(normalisedPhone) : null;

    // 32-char base64url jti — paired with the row's UNIQUE constraint on
    // upload_token_jti so an old token can't be re-presented after the
    // session is finalized (which would rotate this value).
    const jti = randomBytes(24).toString('base64url');

    // Session row's own expiry: the upload-token TTL is 4h (see
    // intakeUploadToken.ts), so a 4h session_expires aligns the two. The
    // tus PATCH route in 28.5 rejects uploads against expired sessions
    // even when the token signature still validates.
    const sessionExpires = new Date(Date.now() + 4 * 60 * 60 * 1000);

    const session = await intakeSessionsRepo.create({
      staff_id: effectiveStaffId,
      source,
      token_id: tokenId,
      client_name_enc: nameEnc,
      client_email_enc: emailEnc,
      client_phone_enc: phoneEnc,
      client_name_lower_hash: nameLowerHash,
      client_email_hash: emailHash,
      client_phone_hash: phoneHash,
      contact_method: contactMethod,
      ip_address: req.ip ?? null,
      user_agent: req.headers['user-agent'] ?? null,
      upload_token_jti: jti,
      expires_at: sessionExpires,
    });

    const { token, expiresAt } = signUploadToken({
      sid: session.id,
      staff: effectiveStaffId,
      jti,
    });

    await auditRepo.write({
      actorUserId: null,
      action: 'intake.session.created',
      targetType: 'intake_session',
      targetId: session.id,
      details: {
        // Hashes only — never the raw IP/UA/name/email/phone. The intake
        // key rotates audit hashes on Phase 28.16 rotation; this is
        // intentional (audit rows tied to a key generation).
        hashed_ip: req.ip ? hashForAudit(req.ip) : null,
        ua_hash: req.headers['user-agent'] ? hashForAudit(String(req.headers['user-agent'])) : null,
        staff_id: effectiveStaffId,
        contact_method: contactMethod,
        turnstile_configured: Boolean(env.turnstileSiteKey && env.turnstileSecretKey),
        turnstile_passed: turnstilePassed,
        source,
        token_id: tokenId,
      },
      ipAddress: req.ip ?? null,
    });

    res.status(201).json({
      sessionId: session.id,
      uploadToken: token,
      expiresAt: expiresAt.toISOString(),
    });
  }),
);

// -------- Phase 28.5 — POST /sessions/:id/finalize --------
//
// Called by the SPA after the last file finishes uploading. Flips the
// session to `finalized`, enqueues the 28.9 PDF-conversion row + the
// 28.10/28.12 notification rows, returns a success URL the client can
// navigate to. Idempotent: re-calling on an already-finalized session
// returns 200 with the same shape.
intakePublicRouter.post(
  '/sessions/:id/finalize',
  requireIntakeWritesEnabled,
  asyncHandler(async (req, res) => {
    const sessionId = req.params.id ?? '';
    // Auth via the upload-token JWT in the Authorization header — same
    // shape as the tus endpoints. We re-verify here even though the
    // client just used the token for uploads, because finalize is a
    // separate logical operation and a stale token (post-finalize re-use)
    // should fail.
    const header = req.header('Authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const verified = verifyUploadToken(m[1]!.trim());
    if (!verified.ok) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (verified.claims.sid !== sessionId) {
      res.status(403).json({ error: 'session_mismatch' });
      return;
    }
    const session = await intakeSessionsRepo.byId(sessionId);
    if (!session || session.upload_token_jti !== verified.claims.jti) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // Idempotent re-finalize: if the session is already finalized, return
    // the same success payload. The client may have lost the navigation
    // and retried.
    if (session.status === 'finalized') {
      const files = await intakeFilesRepo.listBySession(sessionId);
      res.json({
        ok: true,
        sessionId,
        fileCount: files.length,
        successUrl: `/intake/${session.staff_id}/done?s=${sessionId}`,
      });
      return;
    }
    if (session.status !== 'open') {
      // expired / abandoned
      res.status(409).json({ error: 'session_not_open', status: session.status });
      return;
    }

    const files = await intakeFilesRepo.listBySession(sessionId);
    if (files.length === 0) {
      res.status(400).json({ error: 'no_files' });
      return;
    }

    const fileIds = files.map((f) => f.id);
    // Phase 28.15 — read the firm's auto-delete policy ONCE outside the
    // transaction. If enabled at finalize time, stamp the session's
    // `auto_delete_at` so the 28.15 ticker can find it. We read OUTSIDE
    // the transaction because firm_settings is a singleton row whose
    // last write may not be visible to a fresh transaction's REPEATABLE
    // READ snapshot anyway; this just dodges a confusing edge case. A
    // policy flip mid-finalize is a non-issue — the admin PATCH path
    // calls applyRetentionBackfill / clearAllAutoDeleteAt to bring
    // historical rows in line.
    const firmRetention = await db('firm_settings')
      .where({ id: 1 })
      .first<{
        intake_auto_delete_enabled: boolean;
        intake_auto_delete_after_days: number;
      }>(['intake_auto_delete_enabled', 'intake_auto_delete_after_days']);
    const retentionEnabled = Boolean(firmRetention?.intake_auto_delete_enabled);
    const retentionDays = firmRetention?.intake_auto_delete_after_days ?? 365;

    // Flip the session + enqueue dependent rows in one transaction so a
    // partial finalize can't leave the session marked finalized while
    // notifications missed the outbox.
    await db.transaction(async (trx) => {
      await intakeSessionsRepo.finalize(sessionId, trx);
      // Phase 28.15: stamp auto_delete_at = NOW() + N days when the
      // firm has auto-delete enabled. Equivalent to finalized_at + N
      // days since both are NOW() in the same statement. The same
      // transaction guarantees a successful finalize either acquires
      // the policy stamp or rolls back together.
      if (retentionEnabled) {
        await trx.raw(
          `UPDATE intake_sessions
             SET auto_delete_at = NOW() + (?::text || ' days')::interval
           WHERE id = ?`,
          [String(retentionDays), sessionId],
        );
      }
      // Phase 28.14: tokenized sessions count toward the link's use_count
      // exactly once — at finalize time. Sessions that never finalize
      // (abandoned, expired) don't tick the counter. We bump inside the
      // same transaction so a finalize-then-crash doesn't leave a state
      // where the session says "finalized" but the counter missed it.
      if (session.source === 'staff_link' && session.token_id) {
        await trx('intake_links')
          .where({ id: session.token_id })
          .increment('use_count', 1);
      }
      // PDF conversion job (28.9 ticker picks this up).
      await intakePdfsRepo.insertPending(sessionId, fileIds, trx);
      // Client receipt notification (28.10) + staff alert (28.12).
      // Recipient hashes only — the original encrypted fields stay in
      // intake_sessions and only get touched by the notify ticker which
      // decrypts under the intake key, formats the body, and discards
      // the plaintext.
      if (session.client_email_hash) {
        await intakeNotificationsRepo.enqueue(
          {
            session_id: sessionId,
            channel: 'email',
            recipient_hash: session.client_email_hash,
            template_id: 'client.received',
            payload: { file_count: files.length },
          },
          trx,
        );
      }
      if (session.client_phone_hash) {
        await intakeNotificationsRepo.enqueue(
          {
            session_id: sessionId,
            channel: 'sms',
            recipient_hash: session.client_phone_hash,
            template_id: 'client.received',
            payload: { file_count: files.length },
          },
          trx,
        );
      }
      // Staff in-app notice + email (28.12 fanout / ticker). For
      // staff-channel rows `recipient_hash` is the staff user_id (string
      // equality, not an HKDF hash); the ticker resolves the user row
      // for the email destination. Both channels enqueued unconditionally
      // — the email ticker marks the row failed if the staff user has
      // no email address on file rather than silently dropping it.
      await intakeNotificationsRepo.enqueue(
        {
          session_id: sessionId,
          channel: 'in_app',
          recipient_hash: session.staff_id,
          template_id: 'staff.new_intake',
          payload: { file_count: files.length },
        },
        trx,
      );
      await intakeNotificationsRepo.enqueue(
        {
          session_id: sessionId,
          channel: 'email',
          recipient_hash: session.staff_id,
          template_id: 'staff.new_intake',
          payload: { file_count: files.length },
        },
        trx,
      );
    });

    await auditRepo.write({
      actorUserId: null,
      action: 'intake.session.finalized',
      targetType: 'intake_session',
      targetId: sessionId,
      details: {
        file_count: files.length,
        total_bytes: files.reduce((s, f) => s + Number(f.size_bytes), 0),
        ip_hash: req.ip ? hashForAudit(req.ip) : null,
      },
      ipAddress: req.ip ?? null,
    });

    res.json({
      ok: true,
      sessionId,
      fileCount: files.length,
      successUrl: `/intake/${session.staff_id}/done?s=${sessionId}`,
    });
  }),
);
