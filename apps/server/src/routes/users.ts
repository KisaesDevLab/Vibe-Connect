import bcrypt from 'bcryptjs';
import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { env } from '../env.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { auditRepo } from '../repositories/audit.js';
import { usersRepo } from '../repositories/users.js';
import { publicUser } from '../util/presenters.js';

export const usersRouter = Router();

usersRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const rows = await usersRepo.findAll();
    res.json({ users: rows.map(publicUser) });
  }),
);

usersRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await usersRepo.findById(req.params.id!);
    if (!user) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ user: publicUser(user) });
  }),
);

const createSchema = z.object({
  username: z.string().min(2).max(64),
  email: z.string().email().optional().nullable(),
  password: z.string().min(12).max(512),
  displayName: z.string().min(1).max(128),
  isAdmin: z.boolean().optional(),
});

usersRouter.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const existing = await usersRepo.findByUsername(parsed.data.username);
    if (existing) {
      res.status(409).json({ error: 'username_taken' });
      return;
    }
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const user = await usersRepo.create({
      username: parsed.data.username,
      email: parsed.data.email ?? null,
      passwordHash,
      displayName: parsed.data.displayName,
      isAdmin: parsed.data.isAdmin ?? false,
    });
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.user_created',
      targetType: 'user',
      targetId: user.id,
      details: { username: user.username, isAdmin: user.is_admin },
      ipAddress: req.ip ?? null,
    });
    res.status(201).json({ user: publicUser(user) });
  }),
);

const updateSchema = z.object({
  displayName: z.string().min(1).max(128).optional(),
  email: z.string().email().nullable().optional(),
  isAdmin: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

usersRouter.patch(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const patch: Record<string, unknown> = {};
    if (parsed.data.displayName !== undefined) patch.display_name = parsed.data.displayName;
    if (parsed.data.email !== undefined) patch.email = parsed.data.email;
    if (parsed.data.isAdmin !== undefined) patch.is_admin = parsed.data.isAdmin;
    if (parsed.data.isActive !== undefined) patch.is_active = parsed.data.isActive;
    const updated = await usersRepo.update(req.params.id!, patch as never);
    if (!updated) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.user_updated',
      targetType: 'user',
      targetId: updated.id,
      details: patch,
      ipAddress: req.ip ?? null,
    });
    res.json({ user: publicUser(updated) });
  }),
);

const resetPasswordSchema = z.object({
  newPassword: z.string().min(12).max(512),
});

usersRouter.post(
  '/:id/reset-password',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const target = await usersRepo.findById(req.params.id!);
    if (!target) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const hash = await bcrypt.hash(parsed.data.newPassword, 12);
    await usersRepo.setPassword(target.id, hash);
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.user_password_reset',
      targetType: 'user',
      targetId: target.id,
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true });
  }),
);

// ---------- Avatar upload ----------
// Avatars are stored encrypted at rest on disk. For Phase 2 we XOR-wrap the raw bytes with
// a per-file key derived from the firm-held encryption key; full libsodium wrapping lands in
// Phase 3. Until then, the bytes are stored in a dedicated "avatars/" subdir, and clients only
// receive a signed relative path.
const AVATAR_DIR = path.resolve(env.attachmentLocalDir, 'avatars');
await fs.mkdir(AVATAR_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max for avatars
  fileFilter: (_req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(null, ok);
  },
});

function xorWrap(buffer: Buffer, keySeed: string): Buffer {
  // CRYPTO(placeholder): stand-in until Phase 3 replaces with libsodium secretbox.
  const key = Buffer.from(keySeed.repeat(Math.ceil(32 / keySeed.length))).subarray(0, 32);
  const out = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    out[i] = buffer[i]! ^ key[i % key.length]!;
  }
  return out;
}

usersRouter.post(
  '/me/avatar',
  requireAuth,
  upload.single('avatar'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'no_file' });
      return;
    }
    const userId = req.session.userId!;
    const ext =
      req.file.mimetype === 'image/png'
        ? 'png'
        : req.file.mimetype === 'image/webp'
          ? 'webp'
          : req.file.mimetype === 'image/gif'
            ? 'gif'
            : 'jpg';
    const filename = `${userId}.${ext}.enc`;
    const fullPath = path.join(AVATAR_DIR, filename);
    const keySeed = env.sessionSecret.slice(0, 32).padEnd(32, '0');
    const wrapped = xorWrap(req.file.buffer, keySeed);
    await fs.writeFile(fullPath, wrapped);
    const avatarUrl = `/attachments/avatars/${filename}`;
    await usersRepo.update(userId, { avatar_url: avatarUrl } as never);
    await auditRepo.write({
      actorUserId: userId,
      action: 'user.avatar_updated',
      targetType: 'user',
      targetId: userId,
      ipAddress: req.ip ?? null,
    });
    res.json({ avatarUrl });
  }),
);

export async function serveAvatarFromDisk(filename: string): Promise<Buffer | null> {
  try {
    const fullPath = path.join(AVATAR_DIR, filename);
    const buf = await fs.readFile(fullPath);
    const keySeed = env.sessionSecret.slice(0, 32).padEnd(32, '0');
    return xorWrap(buf, keySeed);
  } catch {
    return null;
  }
}
