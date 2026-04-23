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
    };

type Listener = (event: RealtimeEvent) => void;

let pubClient: pg.Client | null = null;
let subClient: pg.Client | null = null;
const listeners = new Set<Listener>();

export async function startFanout(): Promise<void> {
  if (pubClient && subClient) return;
  const connectionString = env.nodeEnv === 'test' ? env.testDatabaseUrl : env.databaseUrl;
  pubClient = new pg.Client({ connectionString });
  subClient = new pg.Client({ connectionString });
  await Promise.all([pubClient.connect(), subClient.connect()]);
  await subClient.query(`LISTEN ${CHANNEL}`);
  subClient.on('notification', (msg) => {
    if (msg.channel !== CHANNEL || !msg.payload) return;
    try {
      const event = JSON.parse(msg.payload) as RealtimeEvent;
      for (const l of listeners) l(event);
    } catch (err) {
      logger.error('pg_notify_parse_failed', { err: String(err), payload: msg.payload });
    }
  });
  subClient.on('error', (err) => logger.error('pg_listener_error', { err: String(err) }));
}

export async function stopFanout(): Promise<void> {
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
