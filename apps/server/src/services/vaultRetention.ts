// Phase 26 — Vault retention sweep + tus orphan reaper.
//
// Runs hourly. Two responsibilities:
//
//   1. Crypto-shred expired vault zones. Files whose `retention_expires_at`
//      is past get soft-deleted; when every live file under a zone is past
//      deletion, the zone's wrapped_keys map is zeroed (cryptoShred) and an
//      audit row records the destruction. Bytes-on-disk stay until the next
//      backup prune; without the wrapped key they are unreadable.
//
//   2. Reap stale tus uploads. Rows in `vault_uploads_in_progress` past
//      their `expires_at` get dropped; orphaned `.part` files are unlinked.
//
// Mirrors services/retention.ts pacing. Production calls `startVaultRetentionTicker()`
// from index.ts; tests call `runVaultRetentionSweep()` directly.
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import { auditRepo } from '../repositories/audit.js';
import {
  vaultFilesRepo,
  vaultKeysRepo,
  type VaultFileRow,
} from '../repositories/vaults.js';
import { reapExpiredTusUploads } from './tusServer.js';
import { VAULT_AUDIT_ACTIONS } from './vaultService.js';

interface VaultRetentionResult {
  filesSoftDeleted: number;
  zonesCryptoShredded: number;
  tusReaped: number;
}

const TICK_MS = 60 * 60 * 1000; // hourly
let ticker: NodeJS.Timeout | null = null;

export function startVaultRetentionTicker(): void {
  if (ticker) return;
  // Fire once shortly after boot so the first sweep happens without waiting
  // a full hour. unref() so the timer doesn't keep the event loop alive
  // during shutdown.
  setTimeout(() => {
    void runVaultRetentionSweep().catch((err) => {
      logger.error('vault_retention.first_tick_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, 60_000).unref();
  ticker = setInterval(() => {
    void runVaultRetentionSweep().catch((err) => {
      logger.error('vault_retention.tick_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, TICK_MS);
  ticker.unref();
}

export function stopVaultRetentionTicker(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

export async function runVaultRetentionSweep(): Promise<VaultRetentionResult> {
  const result: VaultRetentionResult = {
    filesSoftDeleted: 0,
    zonesCryptoShredded: 0,
    tusReaped: 0,
  };

  // 1. Soft-delete files past their per-row retention_expires_at.
  const expired: VaultFileRow[] = await vaultFilesRepo.listExpired();
  for (const f of expired) {
    await vaultFilesRepo.softDelete(f.id);
    await auditRepo.write({
      action: VAULT_AUDIT_ACTIONS.fileDeleted,
      targetType: 'vault_file',
      targetId: f.id,
      details: { vaultId: f.vault_id, zone: f.zone, reason: 'retention' },
    });
    result.filesSoftDeleted += 1;
  }

  // 2. Crypto-shred zones whose every file is soft-deleted AND past retention.
  //    A "closed engagement" signal would tighten this — for v1 we shred a
  //    zone once it's been file-empty for at least 30 days past the most
  //    recent file's retention expiry. The window prevents accidental
  //    shredding of an active vault that just happens to be momentarily
  //    file-less (e.g. staff cleared old uploads but still using it).
  const SHRED_GRACE_DAYS = 30;
  const candidates = (await db('client_vaults as cv')
    .leftJoin('vault_files as f', 'f.vault_id', 'cv.id')
    .select('cv.id as vault_id')
    .groupBy('cv.id')
    .having(
      db.raw(
        `COUNT(f.id) FILTER (WHERE f.deleted_at IS NULL) = 0 AND
         COUNT(f.id) > 0 AND
         MAX(COALESCE(f.retention_expires_at, f.deleted_at, f.uploaded_at)) <
           NOW() - INTERVAL '${SHRED_GRACE_DAYS} days'`,
      ),
    )) as Array<{ vault_id: string }>;
  for (const row of candidates) {
    for (const zone of ['shared', 'staff_only'] as const) {
      const latest = await vaultKeysRepo.latest(row.vault_id, zone);
      if (!latest || Object.keys(latest.wrapped_keys ?? {}).length === 0) continue;
      const updated = await vaultKeysRepo.cryptoShred(row.vault_id, zone);
      if (updated > 0) {
        result.zonesCryptoShredded += 1;
        await auditRepo.write({
          action: VAULT_AUDIT_ACTIONS.zoneCryptoShredded,
          targetType: 'vault_zone',
          targetId: row.vault_id,
          details: { zone, rotationsAffected: updated, reason: 'retention_grace_passed' },
        });
      }
    }
  }

  // 3. Reap stale tus uploads.
  try {
    result.tusReaped = await reapExpiredTusUploads();
  } catch (err) {
    logger.warn('vault_retention.tus_reap_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (result.filesSoftDeleted > 0 || result.zonesCryptoShredded > 0 || result.tusReaped > 0) {
    logger.info('vault_retention.sweep_complete', { ...result });
  }
  return result;
}
