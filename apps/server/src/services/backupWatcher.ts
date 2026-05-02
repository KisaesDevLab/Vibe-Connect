// Periodic operator-visible nag for "no backup heartbeat received."
//
// `ensureBackupFresh` (services/backupGate.ts) runs on every vault upload
// and refuses the request if the heartbeat is too stale; that's the
// hard gate. This watcher is the soft signal: a structured warn-log
// every 6 hours, plus the boot log, so an operator tailing `docker
// logs` sees the staleness even on a quiet appliance with no upload
// traffic.
//
// Skipped entirely when BACKUP_REQUIRED=false (the standalone default)
// — operators self-managing backups don't need a nag.
//
// Implementation choices:
//   - Timer interval is 6 hours, not "every minute that something has
//     gone bad." Operators don't want their journal carpet-bombed when
//     they're already aware of the problem.
//   - First check fires after a 24h grace window from /install so a
//     fresh appliance doesn't yell on day one.
//   - On staleness, includes the days-since-backup figure so log
//     aggregation (loki, datadog) can graph it without parsing a
//     human string.
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { logger } from '../logger.js';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const GRACE_PERIOD_HOURS = 24;

let timer: NodeJS.Timeout | null = null;

async function checkOnce(): Promise<void> {
  try {
    const settings = (await db('firm_settings')
      .where({ id: 1 })
      .first('last_backup_ok_at')) as { last_backup_ok_at: Date | null } | undefined;
    const lastOk = settings?.last_backup_ok_at ?? null;

    if (lastOk) {
      const days = Math.floor(
        (Date.now() - new Date(lastOk).getTime()) / (1000 * 60 * 60 * 24),
      );
      if (days >= env.backupBlockDays) {
        logger.warn('backup.stale_blocking', {
          daysSinceBackup: days,
          blockDays: env.backupBlockDays,
          hint: 'Vault uploads are refused until POST /admin/backup-heartbeat reports ok=true.',
        });
      } else if (days >= env.backupWarnDays) {
        logger.warn('backup.stale_warning', {
          daysSinceBackup: days,
          warnDays: env.backupWarnDays,
          blockDays: env.backupBlockDays,
        });
      }
      // No log when fresh — the success path is silent.
      return;
    }

    // Never any heartbeat. Honor the grace window from install date so a
    // fresh appliance gets time to set up Duplicati before logging warnings.
    const installRow = (await db('firm_keys')
      .whereNull('retired_at')
      .first('created_at')) as { created_at: Date } | undefined;
    if (!installRow) {
      // Pre-install. The /health endpoint is already telling the operator
      // they need to run /install — no need to layer another warning.
      return;
    }
    const ageHours =
      (Date.now() - new Date(installRow.created_at).getTime()) / (1000 * 60 * 60);
    if (ageHours < GRACE_PERIOD_HOURS) return;
    logger.warn('backup.never_heartbeat', {
      hoursSinceInstall: Math.floor(ageHours),
      hint: 'No /admin/backup-heartbeat ever received. Configure your backup tool.',
    });
  } catch (err) {
    // Don't crash the watcher on a transient DB blip. Next tick retries.
    logger.warn('backup.watcher_check_failed', {
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startBackupWatcher(): void {
  if (!env.backupRequired) return;
  if (timer) return;
  // Fire once at boot so the operator gets immediate feedback if things
  // are stale already; subsequent checks at the configured interval.
  void checkOnce();
  timer = setInterval(() => {
    void checkOnce();
  }, CHECK_INTERVAL_MS);
  // Don't keep the event loop alive purely for the watcher — graceful
  // shutdown should still complete.
  timer.unref();
}

export function stopBackupWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
