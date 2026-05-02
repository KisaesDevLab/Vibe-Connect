import { createHash } from 'node:crypto';
import http from 'node:http';
import { createApp } from './app.js';
import { db } from './db/knex.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { startFanout, stopFanout } from './realtime/pgFanout.js';
import { attachRealtime } from './realtime/socket.js';
import {
  setScheduledBroadcaster,
  startScheduledMessageTicker,
  stopScheduledMessageTicker,
} from './services/scheduledMessages.js';
import {
  setDestructBroadcaster,
  startDestructTicker,
  stopDestructTicker,
} from './services/destructMessages.js';
import { startAutoNudgeJob, stopAutoNudgeJob } from './services/autoNudge.js';
import { startRetentionTicker, stopRetentionTicker } from './services/retention.js';
import {
  startVaultRetentionTicker,
  stopVaultRetentionTicker,
} from './services/vaultRetention.js';
import { startBackupWatcher, stopBackupWatcher } from './services/backupWatcher.js';
import { startTlsRenewalTicker, stopTlsRenewalTicker } from './services/tlsAcme.js';

async function main(): Promise<void> {
  const app = createApp();
  const server = http.createServer(app);
  await startFanout();
  const io = attachRealtime(server);

  setScheduledBroadcaster({
    broadcastMessageVisible: async (m) => {
      const { publish } = await import('./realtime/pgFanout.js');
      await publish({
        type: 'message:new',
        conversationId: m.conversationId,
        messageId: m.id,
        senderId: null,
        senderExternalIdentityId: null,
        urgent: false,
        createdAt: new Date().toISOString(),
      });
    },
  });
  startScheduledMessageTicker();
  setDestructBroadcaster({
    broadcastMessageDestructed: async (m) => {
      const { publish } = await import('./realtime/pgFanout.js');
      await publish({
        type: 'message:delete',
        conversationId: m.conversationId,
        messageId: m.id,
      });
    },
  });
  startDestructTicker();
  startAutoNudgeJob();
  startRetentionTicker();
  startVaultRetentionTicker();
  startTlsRenewalTicker();
  startBackupWatcher();

  // Firm-key fingerprint at boot. Logged so an operator inspecting `docker
  // logs` after a restore can verify "this is the same firm key we backed up"
  // before users complain about decrypt failures. SHA-256 of the public-key
  // bytes is safe to expose: it's derived from material the firm key already
  // hands out to every new device for envelope addressing. We log only the
  // first 16 hex chars to keep log lines short — collisions on truncated
  // SHA-256 are not a security concern here, just an operational sanity check.
  //
  // Non-fatal on miss: a fresh install hasn't been through POST /install yet,
  // so firm_keys is empty. Don't block startup — `/health` already reports
  // installed:false for that case.
  try {
    const row = (await db('firm_keys')
      .whereNull('retired_at')
      .first('public_key', 'rotation_version')) as
      | { public_key: string; rotation_version: number }
      | undefined;
    if (row) {
      const fingerprint = createHash('sha256').update(row.public_key, 'utf8').digest('hex').slice(0, 16);
      logger.info('crypto.firm_key_loaded', {
        fingerprint,
        rotation: row.rotation_version,
      });
    } else {
      logger.info('crypto.firm_key_absent', { note: 'awaiting POST /install' });
    }
  } catch (err) {
    // Schema-not-migrated or DB-unreachable. /health surfaces the real cause;
    // we just note we couldn't probe so the absence of crypto.firm_key_loaded
    // in logs isn't mistaken for a missing install.
    logger.warn('crypto.firm_key_probe_failed', {
      msg: err instanceof Error ? err.message : String(err),
    });
  }

  if (env.emailProvider === 'none') {
    // One-shot boot warning — surfaces "outbound mail disabled" without
    // waiting for the first /identify call to log it. Operators tailing
    // docker logs see the configuration explicitly.
    logger.warn('email.provider_none', {
      hint: 'EMAIL_PROVIDER=none — outbound mail is disabled. Portal access codes still send via SMS if SMS_PROVIDER is configured.',
    });
  }

  server.listen(env.port, () => {
    logger.info('server.listening', { port: env.port, env: env.nodeEnv });
  });

  // Graceful shutdown on SIGTERM (docker stop) / SIGINT (Ctrl-C).
  //
  // Order matters — we have to drain traffic before tearing down the pool:
  //   1. Cancel background tickers first so their next iteration doesn't race
  //      the tear-down sequence.
  //   2. Stop accepting new HTTP + Socket.io connections.
  //   3. Wait (bounded) for in-flight HTTP requests to complete — without this
  //      the pool teardown below severs open transactions mid-statement.
  //   4. Close the Socket.io layer and the pgFanout LISTEN/NOTIFY sockets.
  //   5. Drain the knex pool.
  //
  // A hard timeout caps the whole sequence. If anything hangs we exit non-zero
  // so the container orchestrator restarts us instead of wedging.
  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals, exitCode = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server.shutdown_begin', { signal, exitCode });
    const hardTimeout = setTimeout(() => {
      logger.error('server.shutdown_timeout_exiting_nonzero');
      process.exit(1);
    }, 15_000);
    hardTimeout.unref();
    // Tickers stop synchronously.
    stopScheduledMessageTicker();
    stopDestructTicker();
    stopAutoNudgeJob();
    stopRetentionTicker();
    stopVaultRetentionTicker();
    stopTlsRenewalTicker();
    stopBackupWatcher();
    // Drain HTTP. server.close stops accepting new connections and fires the
    // callback after all in-flight requests complete. We give that chance up
    // to 10s; if keep-alive connections are idle we nudge them closed so the
    // callback isn't held hostage by an idle browser tab.
    await new Promise<void>((resolve) => {
      const drainTimeout = setTimeout(() => {
        logger.warn('server.http_drain_timeout');
        resolve();
      }, 10_000);
      drainTimeout.unref();
      server.close((err) => {
        clearTimeout(drainTimeout);
        if (err) logger.warn('server.http_close_err', { err: err.message });
        resolve();
      });
      // Nudge idle keep-alive connections closed so they don't prevent
      // server.close from completing. Node 18.2+ method.
      const withIdleClose = server as typeof server & { closeIdleConnections?: () => void };
      setTimeout(() => {
        try {
          withIdleClose.closeIdleConnections?.();
        } catch {
          /* some node versions lack the helper; the drainTimeout is our backstop */
        }
      }, 2_000).unref();
    });
    // socket.io's close accepts a callback that fires once all connected
    // clients have disconnected and the engine is released. Awaiting this
    // means pending emit()s flush and we don't sever socket-backed realtime
    // state mid-send. A 5s timeout keeps an unreachable browser from pinning
    // the shutdown — the hard 15s outer timeout is the ultimate backstop.
    await new Promise<void>((resolve) => {
      const ioTimeout = setTimeout(() => {
        logger.warn('server.io_close_timeout');
        resolve();
      }, 5_000);
      ioTimeout.unref();
      try {
        io.close(() => {
          clearTimeout(ioTimeout);
          resolve();
        });
      } catch (err) {
        clearTimeout(ioTimeout);
        logger.warn('server.io_close_err', {
          err: err instanceof Error ? err.message : String(err),
        });
        resolve();
      }
    });
    try {
      await stopFanout();
    } catch (err) {
      logger.warn('server.fanout_close_err', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await db.destroy();
    } catch (err) {
      logger.warn('server.db_close_err', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    clearTimeout(hardTimeout);
    logger.info('server.shutdown_done', { exitCode });
    process.exit(exitCode);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  // Crash-level safety net. An unhandled rejection reaching here means we
  // missed a `.catch()` somewhere. Log AND shut down with a non-zero exit so
  // Docker's restart-on-failure / orchestrator policies kick in instead of
  // leaving a half-broken process up.
  process.on('unhandledRejection', (reason) => {
    logger.error('server.unhandled_rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    void shutdown('SIGTERM', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.error('server.uncaught_exception', { err: err.message, stack: err.stack });
    void shutdown('SIGTERM', 1);
  });
}

void main();
