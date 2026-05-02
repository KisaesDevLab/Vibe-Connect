// Vault upload gate — refuses new tus init requests when BACKUP_REQUIRED
// is on and no successful backup has landed in BACKUP_BLOCK_DAYS. The
// goal is to fail loud while the firm key is still recoverable: a
// customer who silently piles up vault writes for a month after their
// backup quietly broke loses every one of those uploads on a key-loss
// event. Reading existing data stays unblocked so the rest of the firm
// keeps working.
//
// Standalone deploys leave BACKUP_REQUIRED unset (defaults to false) and
// every call to the gate returns immediately. Appliance deploys set it
// `true`; the warn window (BACKUP_WARN_DAYS) is surfaced via the admin
// banner; only the block window halts uploads.
import type { Response } from 'express';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { logger } from '../logger.js';

let lastWarnAt = 0;

/**
 * Resolves to `true` when the request may proceed. When the backup is too
 * stale, writes a 503 with `{error: 'backup_stale', daysSinceBackup}` to
 * `res` and resolves to `false` so the caller can `return`.
 *
 * The hot-path query (one indexed select on the singleton firm_settings
 * row) is cheap enough that we don't bother caching — and a stale cache
 * here would be the exact bug the gate exists to prevent.
 */
export async function ensureBackupFresh(res: Response): Promise<boolean> {
  if (!env.backupRequired) return true;
  const row = (await db('firm_settings').where({ id: 1 }).first('last_backup_ok_at')) as
    | { last_backup_ok_at: Date | null }
    | undefined;
  const lastOk = row?.last_backup_ok_at ?? null;
  if (!lastOk) {
    // Never seen a backup. Pre-grace-period (24h post-install) we let
    // it through; after that we block. Use the firm_keys.created_at
    // timestamp as the install marker — that row is created exactly
    // once on /install and is the canonical "the appliance is alive"
    // signal.
    const installRow = (await db('firm_keys').whereNull('retired_at').first('created_at')) as
      | { created_at: Date }
      | undefined;
    const installedAt = installRow?.created_at;
    const graceHours = 24;
    if (installedAt && Date.now() - new Date(installedAt).getTime() < graceHours * 3600 * 1000) {
      return true;
    }
    res.status(503).json({
      error: 'backup_stale',
      detail: 'No successful backup recorded; vault uploads disabled.',
      daysSinceBackup: null,
    });
    return false;
  }
  const days = Math.floor((Date.now() - new Date(lastOk).getTime()) / (1000 * 60 * 60 * 24));
  if (days >= env.backupBlockDays) {
    // Throttle the warn-log so a busy upload UI doesn't fill the journal
    // with one line per click.
    if (Date.now() - lastWarnAt > 60_000) {
      lastWarnAt = Date.now();
      logger.warn('backup.upload_blocked_stale', {
        daysSinceBackup: days,
        blockDays: env.backupBlockDays,
      });
    }
    res.status(503).json({
      error: 'backup_stale',
      detail: `Last successful backup was ${days} days ago; vault uploads disabled.`,
      daysSinceBackup: days,
    });
    return false;
  }
  return true;
}
