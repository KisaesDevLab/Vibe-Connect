/**
 * First-boot admin setup. Bootstraps firm_keys + admin user + recovery phrase display.
 * One-shot: succeeds once, refuses after. Idempotent from `/health` perspective.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { auditRepo } from '../repositories/audit.js';
import { installFirmKey } from '@vibe-connect/crypto';

export const firstBootRouter = Router();

firstBootRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const installed = await db('firm_keys').whereNull('retired_at').first();
    const users = await db('users').count<{ count: string }[]>('* as count');
    res.json({
      installed: Boolean(installed),
      hasAdmin: Number(users[0]!.count) > 0,
    });
  }),
);

const setupSchema = z.object({
  firmName: z.string().min(1).max(255),
  adminUsername: z.string().min(2).max(64),
  adminPassword: z.string().min(12).max(512),
  adminDisplayName: z.string().min(1).max(128),
  adminEmail: z.string().email().optional(),
});

firstBootRouter.post(
  '/install',
  asyncHandler(async (req, res) => {
    const existing = await db('firm_keys').whereNull('retired_at').first();
    if (existing) {
      res.status(400).json({ error: 'already_installed' });
      return;
    }
    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const artifacts = await installFirmKey();
    await db('firm_keys').insert({
      public_key: artifacts.firm.publicKey,
      encrypted_recovery_private_key: artifacts.firm.encryptedRecoveryPrivateKey,
      kdf_params: artifacts.firm.kdfParams,
      kdf_salt: artifacts.firm.kdfSalt,
      rotation_version: 1,
    });
    const hash = await bcrypt.hash(parsed.data.adminPassword, 12);
    const [admin] = await db('users')
      .insert({
        username: parsed.data.adminUsername,
        email: parsed.data.adminEmail ?? null,
        display_name: parsed.data.adminDisplayName,
        password_hash: hash,
        is_admin: true,
        is_active: true,
      })
      .returning(['id']);
    await db('user_presence').insert({ user_id: admin!.id }).onConflict('user_id').ignore();
    await db('firm_settings').where({ id: 1 }).update({ firm_name: parsed.data.firmName });
    await auditRepo.write({
      actorUserId: admin!.id,
      action: 'install.complete',
      targetType: 'firm',
      details: { firmName: parsed.data.firmName, adminUsername: parsed.data.adminUsername },
      ipAddress: req.ip ?? null,
    });
    // Recovery phrase is returned ONCE and never stored server-side.
    res.json({
      ok: true,
      firmPublicKey: artifacts.firm.publicKey,
      recoveryPhrase: artifacts.recoveryPhrase,
      adminUserId: admin!.id,
    });
  }),
);
