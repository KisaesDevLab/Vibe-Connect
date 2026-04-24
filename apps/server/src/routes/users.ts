import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { auditRepo } from '../repositories/audit.js';
import { usersRepo } from '../repositories/users.js';
import { terminateSessionsForUser } from '../services/sessions.js';
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

// Constrain `:id` to a UUID so literal segments like `/users/keys` and `/users/me/*`
// fall through to their dedicated handlers instead of being matched as a user id.
usersRouter.get(
  '/:id([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
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
    // A deactivation must also terminate live sessions — a cookie held by the user
    // should not survive "is_active=false".
    let sessionsTerminated = 0;
    if (parsed.data.isActive === false) {
      sessionsTerminated = await terminateSessionsForUser(updated.id);
    }
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.user_updated',
      targetType: 'user',
      targetId: updated.id,
      details: { ...patch, sessionsTerminated },
      ipAddress: req.ip ?? null,
    });
    res.json({ user: publicUser(updated), sessionsTerminated });
  }),
);

// ---------- Device enrollment (self) ----------
// Staff clients (PWA / Tauri) call this after `enrollDevice()` locally generates an X25519
// keypair wrapped with Argon2id(password). The server only stores the PUBLIC key and the
// encrypted private key — it never sees the unwrapped form, per CLAUDE.md.
const enrollDeviceSchema = z.object({
  deviceId: z.string().min(1).max(128),
  publicKey: z.string().min(1),
  encryptedPrivateKey: z.string().min(1),
  kdfSalt: z.string().min(1),
  kdfParams: z.object({
    opsLimit: z.number().int(),
    memLimit: z.number().int(),
    algorithm: z.literal('argon2id13'),
  }),
  clientPlatform: z.enum(['tauri-win', 'tauri-mac', 'tauri-linux', 'pwa', 'web']),
  clientVersion: z.string().min(1).max(64),
});

usersRouter.post(
  '/me/devices',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = enrollDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const userId = req.session.userId!;
    const existing = await usersRepo.findDeviceKey(userId, parsed.data.deviceId);
    if (existing) {
      // Re-enrollment of the same device id: treat as rotate. Replace the public key + wrap.
      await usersRepo.updateDeviceKey(existing.id, {
        public_key: parsed.data.publicKey,
        encrypted_private_key: parsed.data.encryptedPrivateKey,
        kdf_salt: parsed.data.kdfSalt,
        kdf_params: parsed.data.kdfParams,
        key_version: existing.key_version + 1,
        client_platform: parsed.data.clientPlatform,
        client_version: parsed.data.clientVersion,
        revoked_at: null,
      });
      await auditRepo.write({
        actorUserId: userId,
        action: 'user.device_rekeyed',
        targetType: 'user_key',
        targetId: existing.id,
        details: { deviceId: parsed.data.deviceId, keyVersion: existing.key_version + 1 },
        ipAddress: req.ip ?? null,
      });
      res.json({ ok: true, id: existing.id, keyVersion: existing.key_version + 1 });
      return;
    }
    const inserted = await usersRepo.insertDeviceKey({
      user_id: userId,
      device_id: parsed.data.deviceId,
      public_key: parsed.data.publicKey,
      encrypted_private_key: parsed.data.encryptedPrivateKey,
      kdf_salt: parsed.data.kdfSalt,
      kdf_params: parsed.data.kdfParams,
      client_platform: parsed.data.clientPlatform,
      client_version: parsed.data.clientVersion,
    });
    await auditRepo.write({
      actorUserId: userId,
      action: 'user.device_enrolled',
      targetType: 'user_key',
      targetId: inserted.id,
      details: { deviceId: parsed.data.deviceId, clientPlatform: parsed.data.clientPlatform },
      ipAddress: req.ip ?? null,
    });
    // Signal existing devices to run the rewrap sweep so the brand-new device
    // can read this user's historical conversations as soon as the other
    // devices process the event.
    const { publish } = await import('../realtime/pgFanout.js');
    const { logger } = await import('../logger.js');
    await publish({
      type: 'device:enrolled',
      userId,
      deviceId: parsed.data.deviceId,
    });
    logger.info('device_enrolled_fanout', {
      userId,
      deviceId: parsed.data.deviceId,
      keyRowId: inserted.id,
    });
    res.status(201).json({ ok: true, id: inserted.id, keyVersion: 1 });
  }),
);

// Manual "Sync this device" button. The caller is a device that knows it's
// missing wrapped_keys entries; it can't rewrap for itself, but any other
// member's unlocked device can. We fire the same device:enrolled broadcast
// so every connected tab in the firm re-runs the rewrap sweep.
usersRouter.post(
  '/me/devices/request-sync',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.session.userId!;
    const { publish } = await import('../realtime/pgFanout.js');
    const { logger } = await import('../logger.js');
    // Which device is asking? Best-effort — we use any active device of the
    // caller so the event payload is well-formed; every receiving tab sweeps
    // regardless of which device id is named.
    const row = await db('user_keys')
      .where({ user_id: userId })
      .whereNull('revoked_at')
      .orderBy('created_at', 'desc')
      .first();
    const deviceId = row?.device_id ?? 'manual-sync';
    await publish({ type: 'device:enrolled', userId, deviceId });
    logger.info('device_sync_requested', { userId, deviceId });
    res.json({ ok: true });
  }),
);

usersRouter.get(
  '/me/devices',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.session.userId!;
    const rows = await usersRepo.listDeviceKeys(userId);
    res.json({
      devices: rows.map((r) => ({
        id: r.id,
        deviceId: r.device_id,
        publicKey: r.public_key,
        keyVersion: r.key_version,
        clientPlatform: r.client_platform,
        clientVersion: r.client_version,
        lastHeartbeatAt: r.last_heartbeat_at,
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
      })),
    });
  }),
);

// Look up active device public keys for a set of users. Anyone authenticated can read these;
// only public halves leave the server and only for active (non-revoked) devices.
// Cap the directory-lookup fan-out. A realistic conversation-start includes the
// caller + up to a few dozen recipients; 100 covers ad-hoc groups with headroom.
const USERS_KEYS_MAX = 100;

usersRouter.get(
  '/keys',
  requireAuth,
  asyncHandler(async (req, res) => {
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[0-9a-f-]{36}$/i.test(s))
      .slice(0, USERS_KEYS_MAX);
    if (ids.length === 0) {
      res.json({ keys: {} });
      return;
    }
    const rows = await usersRepo.listActiveDeviceKeysForUsers(ids);
    const grouped: Record<string, Array<{ deviceId: string; publicKey: string; keyVersion: number }>> = {};
    for (const r of rows) {
      const list = grouped[r.user_id] ?? (grouped[r.user_id] = []);
      list.push({ deviceId: r.device_id, publicKey: r.public_key, keyVersion: r.key_version });
    }
    res.json({ keys: grouped });
  }),
);

const resetPasswordSchema = z.object({
  // Acting admin re-confirms their own password. A stolen admin session
  // otherwise has one-click takeover of every account in the firm, which is
  // the worst-case blast radius for this endpoint. Matches the pattern on
  // /auth/change-password.
  adminPassword: z.string().min(1).max(512),
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
    const actor = await usersRepo.findById(req.session.userId!);
    if (!actor) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const actorOk = await bcrypt.compare(parsed.data.adminPassword, actor.password_hash);
    if (!actorOk) {
      // Audit-log the failure so repeated attempts light up on the admin
      // audit feed. Don't disclose whether the acting admin account exists.
      await auditRepo.write({
        actorUserId: req.session.userId!,
        action: 'admin.user_password_reset_rejected',
        targetType: 'user',
        targetId: req.params.id!,
        details: { reason: 'admin_password_mismatch' },
        ipAddress: req.ip ?? null,
      });
      res.status(401).json({ error: 'admin_password_mismatch' });
      return;
    }
    const target = await usersRepo.findById(req.params.id!);
    if (!target) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const hash = await bcrypt.hash(parsed.data.newPassword, 12);
    await usersRepo.setPassword(target.id, hash);
    // Kill all persisted sessions for this user — holding the old cookie should not
    // survive an admin-initiated password reset.
    const killed = await terminateSessionsForUser(target.id);
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.user_password_reset',
      targetType: 'user',
      targetId: target.id,
      details: { sessionsTerminated: killed },
      ipAddress: req.ip ?? null,
    });
    res.json({ ok: true, sessionsTerminated: killed });
  }),
);

// ---------- Avatar upload ----------
// Avatars are encrypted at rest on disk with libsodium XChaCha20-Poly1305 (secretbox).
// This is NOT end-to-end — the server holds the key — it's defense-in-depth for the
// appliance disk. The key is derived from SESSION_SECRET with HKDF-like SHA-256 so
// rotating SESSION_SECRET correctly invalidates all stored avatars.
//
// CRYPTO: the raw bytes are prefixed with the 24-byte nonce followed by the ciphertext;
// decoding is handled by `secretboxDecrypt` from the crypto package.
import nodeCrypto from 'node:crypto';
import { secretboxDecrypt, secretboxEncrypt } from '@vibe-connect/crypto';

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

function avatarKey(): Uint8Array {
  // Deterministic 32-byte key from SESSION_SECRET via HKDF-Extract (SHA-256).
  // Storing a separate avatar key would require another env var + rotation story.
  return new Uint8Array(
    nodeCrypto.hkdfSync('sha256', env.sessionSecret, Buffer.alloc(0), 'vibe-connect-avatars', 32),
  );
}

// 20 uploads per hour per user is plenty for live-typing changes; it still stops
// a runaway script from filling disk with avatar blobs.
const avatarLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.session.userId ?? req.ip ?? 'anon',
});

usersRouter.post(
  '/me/avatar',
  requireAuth,
  avatarLimiter,
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
    const wrapped = await secretboxEncrypt(new Uint8Array(req.file.buffer), avatarKey());
    await fs.writeFile(fullPath, wrapped, { encoding: 'utf8' });
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
    const blob = await fs.readFile(fullPath, 'utf8');
    const plain = await secretboxDecrypt(blob, avatarKey());
    return Buffer.from(plain);
  } catch {
    return null;
  }
}
