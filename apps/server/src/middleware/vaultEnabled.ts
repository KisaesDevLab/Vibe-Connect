// Phase 26 — Client Vault kill-switch middleware.
//
// Reads firm_settings.vault_enabled per request so an admin flipping the
// toggle takes effect without a server restart. Mirrors the requests-enabled
// middleware in routes/requests.ts.
//
// Staff routes 403 on disable. Portal routes prefer to soft-degrade
// (return `{vaultDisabled: true, ...}` from the handler) so the UI can
// render an "admin disabled this" banner instead of a generic failure.
import type { Request, Response, NextFunction } from 'express';
import { db } from '../db/knex.js';
import { asyncHandler } from './asyncHandler.js';

/**
 * Hard 403 when the firm has the vault disabled. Use on staff routes.
 */
export const requireVaultEnabled = asyncHandler(
  async (_req: Request, res: Response, next: NextFunction) => {
    const settings = await db('firm_settings').where({ id: 1 }).first('vault_enabled');
    if (settings && settings.vault_enabled === false) {
      res.status(403).json({ error: 'vault_disabled' });
      return;
    }
    next();
  },
);

/**
 * Soft check for portal routes — populates `req.vaultDisabled` so the route
 * handler can return a graceful empty payload instead of 403.
 */
export const checkVaultEnabledSoft = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const settings = await db('firm_settings').where({ id: 1 }).first('vault_enabled');
    (req as Request & { vaultDisabled?: boolean }).vaultDisabled =
      settings?.vault_enabled === false;
    next();
  },
);
