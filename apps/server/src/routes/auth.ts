import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { auditRepo } from '../repositories/audit.js';
import { usersRepo } from '../repositories/users.js';
import { normalizePhone } from '../services/accessCodes.js';
import { publicUser } from '../util/presenters.js';

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  // Intentionally min(1), not min(12). Create-password and change-password
  // enforce the 12-char policy going forward, but login must accept shorter
  // passwords for accounts created before that policy was introduced.
  // Validation is bcrypt-bounded anyway (invalid passwords never authenticate);
  // this is a schema-compatibility note, not a security gap.
  password: z.string().min(1).max(512),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(512),
});

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.rateLimitLoginPerMin,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

// Self-service password change: 5 per hour per user. Generous for normal use but
// caps any brute-force on `currentPassword` (bcrypt compare is slow but not free).
const changePasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
  keyGenerator: (req) => req.session.userId ?? req.ip ?? 'anon',
});

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const { username, password } = parsed.data;
    const user = await usersRepo.findByUsername(username);
    // Constant-ish time compare regardless of whether user exists.
    const hash =
      user?.password_hash ?? '$2a$12$00000000000000000000000000000000000000000000000000000';
    const ok = await bcrypt.compare(password, hash);
    if (!user || !user.is_active || !ok) {
      await auditRepo.write({
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: user?.id ?? null,
        details: { username },
        ipAddress: req.ip ?? null,
      });
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    // Regenerate to prevent session fixation.
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.userId = user.id;
    req.session.isAdmin = user.is_admin;
    req.session.username = user.username;
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
    await usersRepo.update(user.id, { last_seen_at: new Date().toISOString() });
    await auditRepo.write({
      actorUserId: user.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: user.id,
      ipAddress: req.ip ?? null,
    });
    res.json({ user: publicUser(user) });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const userId = req.session.userId;
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie(env.sessionCookieName, { path: env.sessionCookiePath });
    if (userId) {
      await auditRepo.write({
        actorUserId: userId,
        action: 'auth.logout',
        targetType: 'user',
        targetId: userId,
        ipAddress: req.ip ?? null,
      });
    }
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await usersRepo.findById(req.session.userId!);
    if (!user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({ user: publicUser(user) });
  }),
);

// Self-service profile edits. Currently limited to contact channels used by
// the offline-notify fallback pipeline (email, phone). Password lives on
// /auth/change-password because it has additional invariants (session
// invalidation, rate-limit); display name + username stay admin-only to keep
// a stable directory.
//
// Both fields use `null` to clear the value. `undefined` (omit the key) means
// "leave it alone" — standard PATCH semantics so the staff UI can patch just
// one channel without wiping the other.
const updateMeSchema = z.object({
  email: z.union([z.string().email().max(255), z.null()]).optional(),
  phone: z.union([z.string().min(1).max(32), z.null()]).optional(),
});

authRouter.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = updateMeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const patch: Record<string, unknown> = {};
    const changes: Record<string, unknown> = {};
    // `'field' in parsed.data` doesn't narrow the optional/nullable union, so
    // we keep an explicit undefined-vs-null check: undefined → "leave alone",
    // null → "clear", otherwise trim/normalize and update.
    if (parsed.data.email !== undefined) {
      const value = parsed.data.email;
      const normalized = value === null ? null : value.trim().toLowerCase();
      patch.email = normalized;
      changes.email = normalized;
    }
    if (parsed.data.phone !== undefined) {
      const value = parsed.data.phone;
      if (value === null) {
        patch.phone = null;
        changes.phone = null;
      } else {
        const normalized = normalizePhone(value);
        if (!normalized) {
          res.status(400).json({ error: 'invalid_phone', detail: 'phone too short or malformed' });
          return;
        }
        patch.phone = normalized;
        changes.phone = normalized;
      }
    }
    if (Object.keys(patch).length === 0) {
      // Nothing to do — return the current user so the client's cache can refresh.
      const current = await usersRepo.findById(req.session.userId!);
      if (!current) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      res.json({ user: publicUser(current) });
      return;
    }
    const updated = await usersRepo.update(req.session.userId!, patch);
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'user.self_updated',
      targetType: 'user',
      targetId: req.session.userId!,
      // Never log raw values — just the field names that changed. Phone + email
      // are PII; the audit row is enough to reconstruct "who changed what, when"
      // without leaking the values themselves into the audit trail.
      details: { fields: Object.keys(changes) },
      ipAddress: req.ip ?? null,
    });
    res.json({ user: publicUser(updated!) });
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  changePasswordLimiter,
  asyncHandler(async (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const user = await usersRepo.findById(req.session.userId!);
    if (!user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const ok = await bcrypt.compare(parsed.data.currentPassword, user.password_hash);
    if (!ok) {
      res.status(400).json({ error: 'invalid_credentials' });
      return;
    }
    const newHash = await bcrypt.hash(parsed.data.newPassword, 12);
    await usersRepo.setPassword(user.id, newHash);
    // Invalidate every OTHER session for this user. We keep the current session alive
    // so the password change doesn't bounce the caller to the login page mid-workflow;
    // the authoritative session row is `req.sessionID`.
    const deleted = await db('session')
      .whereRaw(`sess->>'userId' = ?`, [user.id])
      .andWhereNot('sid', req.sessionID)
      .del();
    await auditRepo.write({
      actorUserId: user.id,
      action: 'auth.password_changed',
      targetType: 'user',
      targetId: user.id,
      details: { otherSessionsTerminated: deleted },
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true, otherSessionsTerminated: deleted });
  }),
);
