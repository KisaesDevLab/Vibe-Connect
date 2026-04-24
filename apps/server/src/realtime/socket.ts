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
      default:
        logger.warn('unhandled_realtime_event', { event });
    }
  });

  io.on('close', () => off());

  return io;
}
