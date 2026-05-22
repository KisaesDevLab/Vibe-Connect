/**
 * Socket.io server: session-authenticated staff connections + (Phase 19+) client-session
 * token authenticated portal connections. Delivery is always ciphertext; clients decrypt
 * client-side using their wrapped conversation key.
 */
import type { Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import session from 'express-session';
import ConnectPgSimple from 'connect-pg-simple';
import type { IncomingMessage } from 'node:http';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { onEvent, publish, type RealtimeEvent } from './pgFanout.js';
import { presenceRepo } from './presence.js';
import { conversationMembersRepo } from '../repositories/conversations.js';
import { db } from '../db/knex.js';

interface SessionRequest extends IncomingMessage {
  session?: {
    userId?: string;
    isAdmin?: boolean;
    username?: string;
  };
}

export function attachRealtime(httpServer: HttpServer): IOServer {
  const io = new IOServer(httpServer, {
    // Reflect the request origin. See apps/server/src/app.ts for the rationale
    // (LAN IPs, hostnames, reverse proxies can't be enumerated). Access is
    // gated by the shared express-session cookie — every socket.io connection
    // is rejected unless req.session.userId is set.
    cors: { origin: (origin, cb) => cb(null, origin ?? true), credentials: true },
  });

  // Staff: share express-session with the HTTP side.
  const PgStore = ConnectPgSimple(session);
  const mw = session({
    name: env.sessionCookieName,
    secret: env.sessionSecret,
    store: new PgStore({
      conString: env.nodeEnv === 'test' ? env.testDatabaseUrl : env.databaseUrl,
      tableName: 'session',
      createTableIfMissing: false,
    }),
    cookie: {
      httpOnly: true,
      // Match the HTTP-side session cookie config exactly. saveUninitialized:
      // false means the handshake middleware never writes a Set-Cookie in
      // practice — the staff session always already exists by the time the
      // SPA opens a socket — but if a future code path triggers a regenerate
      // we don't want a stale path-/ cookie shadowing the path-/connect
      // cookie the HTTP side issued.
      path: env.sessionCookiePath,
      secure: env.sessionSecure,
      sameSite: env.sessionSameSite,
      maxAge: 1000 * 60 * 60 * 12,
    },
    saveUninitialized: false,
    resave: false,
  });
  io.engine.use(mw);

  io.use((socket, next) => {
    const req = socket.request as SessionRequest;
    const uid = req.session?.userId;
    if (!uid) return next(new Error('unauthorized'));
    socket.data = {
      userId: uid,
      username: req.session?.username ?? null,
      isAdmin: req.session?.isAdmin === true,
    };
    next();
  });

  const userSockets = new Map<string, Set<string>>(); // userId -> socket.ids

  io.on('connection', async (socket: Socket) => {
    const { userId } = socket.data as { userId: string };
    await presenceRepo.connect(userId);
    const set = userSockets.get(userId) ?? userSockets.set(userId, new Set()).get(userId)!;
    set.add(socket.id);
    socket.join(`user:${userId}`);
    await publish({
      type: 'presence:update',
      userId,
      status: 'active',
      lastSeenAt: new Date().toISOString(),
    });

    socket.on('conversation:join', async (conversationId: string) => {
      if (typeof conversationId !== 'string' || conversationId.length !== 36) return;
      const ok = await conversationMembersRepo.isMember(conversationId, userId);
      if (!ok) return;
      socket.join(`conv:${conversationId}`);
    });

    socket.on('conversation:leave', (conversationId: string) => {
      socket.leave(`conv:${conversationId}`);
    });

    socket.on('typing:start', async (conversationId: string) => {
      const ok = await conversationMembersRepo.isMember(conversationId, userId);
      if (!ok) return;
      socket.to(`conv:${conversationId}`).emit('typing:start', { conversationId, userId });
    });
    socket.on('typing:stop', async (conversationId: string) => {
      const ok = await conversationMembersRepo.isMember(conversationId, userId);
      if (!ok) return;
      socket.to(`conv:${conversationId}`).emit('typing:stop', { conversationId, userId });
    });

    socket.on('presence:ping', async () => {
      await presenceRepo.heartbeat(userId);
    });

    socket.on('disconnect', async () => {
      set.delete(socket.id);
      if (set.size === 0) userSockets.delete(userId);
      const remaining = await presenceRepo.disconnect(userId);
      if (remaining === 0) {
        await publish({
          type: 'presence:update',
          userId,
          status: 'offline',
          lastSeenAt: new Date().toISOString(),
        });
      }
    });
  });

  // Bridge pg fanout events into socket rooms.
  const off = onEvent((event: RealtimeEvent) => {
    switch (event.type) {
      case 'message:new':
      case 'message:edit':
      case 'message:delete':
      case 'conversation:rekey':
        io.to(`conv:${event.conversationId}`).emit(event.type, event);
        break;
      case 'message:read':
        io.to(`conv:${event.conversationId}`).emit('message:read', event);
        break;
      case 'presence:update':
        io.emit('presence:update', event);
        break;
      case 'device:revoked':
        io.to(`user:${event.userId}`).emit('device:revoked', { deviceId: event.deviceId });
        break;
      case 'device:enrolled':
        // Scope to the enrolling user's own tabs + the conversation rooms
        // they're in. Pre-fix this was a firm-wide broadcast, which leaked
        // device-provisioning timestamps to every signed-in staff member.
        // Rewrap for existing conversations is triggered by the per-room
        // `conversation:wrapped-keys-updated` event published after the
        // server-side merge, not by this announcement.
        io.to(`user:${event.userId}`).emit('device:enrolled', {
          userId: event.userId,
          deviceId: event.deviceId,
        });
        break;
      case 'conversation:wrapped-keys-updated':
        // Target every member's user: room so even devices that haven't joined
        // the conv: room (just-enrolled browsers, offline-then-reconnecting
        // tabs) get the signal and refetch wrappedKeys.
        for (const uid of event.memberUserIds) {
          io.to(`user:${uid}`).emit('conversation:wrapped-keys-updated', {
            conversationId: event.conversationId,
            addedRecipientIds: event.addedRecipientIds,
          });
        }
        break;
      case 'client:session_created':
        // v0.4.35 — fanned out to every staff user in any conversation
        // this client is a member of, so their already-unlocked staff
        // device(s) run the rewrap sweep immediately and wrap the
        // conversation key for the new session's public key. Without
        // this push, the portal client's "decrypting…" state could
        // hang for up to 60s (next sweep tick) or indefinitely if no
        // staff is online. The client-side sweep itself is unchanged
        // — it's the same code path that handles every other
        // missing-recipient case.
        for (const uid of event.memberUserIds) {
          io.to(`user:${uid}`).emit('client:session_created', {
            externalIdentityId: event.externalIdentityId,
            sessionId: event.sessionId,
          });
        }
        break;
      case 'request:changed':
        // Phase 24: send to every member already in the conversation room.
        // Both staff (in conv:<id>) and portal clients (joined via the same
        // pattern in their own connect handler) refetch the request list.
        io.to(`conv:${event.conversationId}`).emit('request:changed', {
          conversationId: event.conversationId,
          listId: event.listId,
          itemId: event.itemId,
        });
        break;
      case 'vault:file-uploaded':
      case 'vault:file-deleted':
        // Phase 26: target staff users who share at least one non-removed
        // conversation membership with the vault's external identity. Payload
        // is metadata-only (file id + zone + actor) — no filenames, no
        // ciphertext. Portal clients poll for vault changes; we don't push
        // through socket.io to them today.
        if ('externalIdentityId' in event && event.externalIdentityId) {
          void notifyStaffForExternalIdentity(io, event);
        }
        break;
      case 'vault:rekey':
        // Notify every staff socket so they can refetch wrapped keys for the
        // vault if they have it open. Cheap: payload is three IDs.
        io.emit('vault:rekey', {
          vaultId: event.vaultId,
          zone: event.zone,
          rotationVersion: event.rotationVersion,
        });
        break;
      case 'intake.session.received':
        // Phase 28.12: notify the assigned staff's own sockets only.
        // Payload carries metadata (session id + file count); the staff
        // SPA refetches the audited /admin/intake/sessions/:id detail
        // to surface the client name. Other staff don't see the event —
        // intake sessions are scoped per-staff.
        io.to(`user:${event.userId}`).emit('intake.session.received', {
          sessionId: event.sessionId,
          fileCount: event.fileCount,
          createdAt: event.createdAt,
        });
        break;
      default:
        logger.warn('unhandled_realtime_event', { event });
    }
  });

  io.on('close', () => off());

  return io;
}

/**
 * Phase 26: fan out a vault file event to staff who share a conversation
 * with the vault's external_identity. Payload is metadata only — file id,
 * zone, vault id, actor id. No filename, no ciphertext, no audit detail.
 */
async function notifyStaffForExternalIdentity(
  io: IOServer,
  event: Extract<RealtimeEvent, { type: 'vault:file-uploaded' | 'vault:file-deleted' }>,
): Promise<void> {
  try {
    const rows = (await db('conversation_members as cm')
      .join('conversations as c', 'c.id', 'cm.conversation_id')
      .join('conversation_members as cm2', 'cm2.conversation_id', 'c.id')
      .where('cm.external_identity_id', event.externalIdentityId)
      .whereNull('cm.removed_at')
      .whereNotNull('cm2.user_id')
      .whereNull('cm2.removed_at')
      .distinct('cm2.user_id')) as Array<{ user_id: string }>;
    for (const r of rows) {
      io.to(`user:${r.user_id}`).emit(event.type, {
        type: event.type,
        vaultId: event.vaultId,
        externalIdentityId: event.externalIdentityId,
        fileId: event.fileId,
        zone: event.zone,
      });
    }
  } catch (err) {
    logger.warn('vault_realtime_fanout_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
