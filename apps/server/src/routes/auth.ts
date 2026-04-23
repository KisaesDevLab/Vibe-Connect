import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../env.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { auditRepo } from '../repositories/audit.js';
import { usersRepo } from '../repositories/users.js';
import { publicUser } from '../util/presenters.js';

const loginSchema = z.object({
  username: z.string().min(1).max(64),
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
    await usersRepo.update(user.id, { last_seen_at: new Date().toISOString() as never });
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
    res.clearCookie(env.sessionCookieName);
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

authRouter.post(
  '/change-password',
  requireAuth,
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
    await auditRepo.write({
      actorUserId: user.id,
      action: 'auth.password_changed',
      targetType: 'user',
      targetId: user.id,
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true });
  }),
);
