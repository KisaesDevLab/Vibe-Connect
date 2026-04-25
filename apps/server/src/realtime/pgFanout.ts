/**
 * Postgres LISTEN/NOTIFY bridge so multiple server instances can broadcast Socket.io events.
 * Every realtime emit goes through `publish(event)`; each instance LISTENs on `connect_events`
 * and re-emits locally.
 *
 * Payloads are *metadata only* — message ciphertext is re-fetched by the client after receiving
 * an event. Keeps the fanout channel small and avoids leaking ciphertext across instances.
 */
import pg from 'pg';
import { env } from '../env.js';
import { logger } from '../logger.js';

const CHANNEL = 'connect_events';

export type RealtimeEvent =
  | {
      type: 'message:new';
      conversationId: string;
      messageId: string;
      senderId: string | null;
      senderExternalIdentityId: string | null;
      urgent: boolean;
      createdAt: string;
    }
  | {
      type: 'message:edit';
      conversationId: string;
      messageId: string;
    }
  | {
      type: 'message:delete';
      conversationId: string;
      messageId: string;
    }
  | {
      type: 'message:read';
      conversationId: string;
      messageId: string;
      userId: string | null;
      externalIdentityId: string | null;
      readAt: string;
    }
  | {
      type: 'conversation:rekey';
      conversationId: string;
      rotationVersion: number;
    }
  | {
      type: 'presence:update';
      userId: string;
      status: 'active' | 'away' | 'dnd' | 'offline';
      lastSeenAt: string;
    }
  | {
      type: 'device:revoked';
      userId: string;
      deviceId: string;
    }
  | {
      // Fires when any user enrolls a new device. Already-enrolled devices of
      // conversation members treat this as a signal to run the rewrap sweep so
      // the new device can decrypt existing conversations.
      type: 'device:enrolled';
      userId: string;
      deviceId: string;
    }
  | {
      // Fires after an additive wrapped-keys merge. Targeted at every current
      // member of the conversation via their user: room so even devices that
      // haven't joined the conv: room yet (just enrolled) get woken up and
      // refetch the conversation detail to pick up their new entry.
      type: 'conversation:wrapped-keys-updated';
      conversationId: string;
      memberUserIds: string[];
      addedRecipientIds: string[];
    }
  | {
      // Phase 24: a request_list or request_item changed in a way that needs
      // every conversation member to refetch the panel. Carries enough IDs
      // for the client to invalidate the right query without hitting the
      // server with a full poll. itemId is omitted for list-level events
      // (creation, status change, cancel).
      type: 'request:changed';
      conversationId: string;
      listId: string;
      itemId?: string;
    }
  | {
      // Phase 26: a vault file landed (clean scan). Subscribers: staff with
      // any conversation membership against the vault's external_identity,
      // plus the active client session for shared-zone events.
      type: 'vault:file-uploaded';
      vaultId: string;
      externalIdentityId: string;
      fileId: string;
      zone: 'shared' | 'staff_only';
      actorUserId: string | null;
      actorExternalIdentityId: string | null;
    }
  | {
      // Phase 26: vault file soft-deleted.
      type: 'vault:file-deleted';
      vaultId: string;
      externalIdentityId: string;
      fileId: string;
      zone: 'shared' | 'staff_only';
      actorUserId: string | null;
      actorExternalIdentityId: string | null;
    }
  | {
      // Phase 26: vault zone key rotated (staff add/remove). Clients refetch
      // their wrapped key for the new rotation_version.
      type: 'vault:rekey';
      vaultId: string;
      zone: 'shared' | 'staff_only';
      rotationVersion: number;
    };

type Listener = (event: RealtimeEvent) => void;

let pubClient: pg.Client | null = null;
let subClient: pg.Client | null = null;
let stopped = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
const listeners = new Set<Listener>();

function connectionString(): string {
  return env.nodeEnv === 'test' ? env.testDatabaseUrl : env.databaseUrl;
}

/**
 * Exponential backoff reconnect for the LISTEN socket.
 *
 * The pg LISTEN socket can drop for a number of mundane reasons — Postgres
 * restart, NAT idle timer, network hiccup — and the pre-fix implementation
 * only logged the error. That left the appliance in a "looks healthy but
 * silently stops fanning out events" state until someone restarted the app.
 * This handler re-establishes the subscriber (and the publisher, which may
 * have died at the same time) with capped backoff. Each successful reconnect
 * resets the attempt counter so future outages start at the small delay again.
 */
function scheduleReconnect(reason: string): void {
  if (stopped || reconnectTimer) return;
  // Cap the counter. The delayMs is already capped by Math.min(30_000, ...),
  // but the raw counter growing unbounded across a days-long outage would
  // eventually overflow Number precision. 10 is enough to reach the delay
  // ceiling and more than enough for telemetry.
  reconnectAttempt = Math.min(reconnectAttempt + 1, 10);
  const delayMs = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempt, 6));
  logger.warn('pg_fanout_reconnecting', { reason, attempt: reconnectAttempt, delayMs });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void reconnect();
  }, delayMs);
}

async function reconnect(): Promise<void> {
  if (stopped) return;
  const prevPub = pubClient;
  const prevSub = subClient;
  pubClient = null;
  subClient = null;
  if (prevSub) {
    try {
      await prevSub.end();
    } catch {
      /* stale socket — ignore */
    }
  }
  if (prevPub) {
    try {
      await prevPub.end();
    } catch {
      /* stale socket — ignore */
    }
  }
  try {
    await wireClients();
    reconnectAttempt = 0;
    logger.info('pg_fanout_reconnected');
  } catch (err) {
    logger.error('pg_fanout_reconnect_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    scheduleReconnect('reconnect_failed');
  }
}

async function wireClients(): Promise<void> {
  const cs = connectionString();
  const pub = new pg.Client({ connectionString: cs });
  const sub = new pg.Client({ connectionString: cs });
  try {
    await Promise.all([pub.connect(), sub.connect()]);
    await sub.query(`LISTEN ${CHANNEL}`);
  } catch (err) {
    // Partial failure (one socket connected, the other didn't, or LISTEN
    // failed). Close whatever did come up so we don't leak sockets, then
    // surface the error to the caller for retry.
    try {
      await pub.end();
    } catch {
      /* ignore */
    }
    try {
      await sub.end();
    } catch {
      /* ignore */
    }
    throw err;
  }
  // Race: stopFanout may have been called while we were awaiting connects.
  // If so, immediately close the fresh sockets — otherwise they'd leak,
  // staying open past `stopFanout` return because the module-level refs
  // weren't set yet.
  if (stopped) {
    try {
      await pub.end();
    } catch {
      /* ignore */
    }
    try {
      await sub.end();
    } catch {
      /* ignore */
    }
    return;
  }
  sub.on('notification', (msg) => {
    if (msg.channel !== CHANNEL || !msg.payload) return;
    try {
      const event = JSON.parse(msg.payload) as RealtimeEvent;
      for (const l of listeners) l(event);
    } catch (err) {
      logger.error('pg_notify_parse_failed', { err: String(err), payload: msg.payload });
    }
  });
  // Both sockets can drop independently. `end` fires on a clean close, `error`
  // on an abrupt one — treat either as a signal to rebuild the pair.
  sub.on('error', (err) => {
    logger.error('pg_listener_error', { err: String(err) });
    scheduleReconnect('sub_error');
  });
  sub.on('end', () => scheduleReconnect('sub_end'));
  pub.on('error', (err) => {
    logger.error('pg_publisher_error', { err: String(err) });
    scheduleReconnect('pub_error');
  });
  pub.on('end', () => scheduleReconnect('pub_end'));
  pubClient = pub;
  subClient = sub;
}

export async function startFanout(): Promise<void> {
  if (pubClient && subClient) return;
  stopped = false;
  await wireClients();
}

export async function stopFanout(): Promise<void> {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const p = pubClient;
  const s = subClient;
  pubClient = null;
  subClient = null;
  listeners.clear();
  if (s) await s.end();
  if (p) await p.end();
}

export function onEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function publish(event: RealtimeEvent): Promise<void> {
  if (!pubClient) {
    // Fire the event locally only — used in tests without fanout wired.
    for (const l of listeners) l(event);
    return;
  }
  await pubClient.query(`SELECT pg_notify($1, $2)`, [CHANNEL, JSON.stringify(event)]);
}
