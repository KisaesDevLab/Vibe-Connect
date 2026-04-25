/**
 * useRealtime — Socket.io client that invalidates TanStack Query caches when events fire.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { api } from '../api.js';
import { getBoot, url } from '../lib/boot.js';
import { useAuth } from './auth.js';
import { useCrypto, wipeDeviceSecrets } from './crypto.js';
import { SearchIndex } from './search.js';

interface TypingEvent {
  conversationId: string;
  userId: string;
}

type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface RealtimeCtx {
  socket: Socket | null;
  typingByConversation: Record<string, Set<string>>;
  emitTyping: (conversationId: string, state: 'start' | 'stop') => void;
  connectionStatus: ConnectionStatus;
}
const Ctx = createContext<RealtimeCtx>({
  socket: null,
  typingByConversation: {},
  emitTyping: () => undefined,
  connectionStatus: 'disconnected',
});

export function RealtimeProvider({ children }: { children: ReactNode }): JSX.Element {
  const { user } = useAuth();
  const { device } = useCrypto();
  const myDeviceId = device?.deviceId ?? null;
  const qc = useQueryClient();
  const sockRef = useRef<Socket | null>(null);
  const [typingByConversation, setTypingByConversation] = useState<Record<string, Set<string>>>({});
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  // Auto-expire typing flags if we miss the stop event; otherwise a dropped socket
  // leaves stale "user is typing" notes on everyone else's screens.
  const typingTimers = useRef<Map<string, number>>(new Map());

  const clearTyping = useCallback((convId: string, uid: string) => {
    setTypingByConversation((prev) => {
      const set = prev[convId];
      if (!set || !set.has(uid)) return prev;
      const next = new Set(set);
      next.delete(uid);
      return { ...prev, [convId]: next };
    });
  }, []);

  const markTyping = useCallback(
    (convId: string, uid: string) => {
      setTypingByConversation((prev) => {
        const set = prev[convId] ?? new Set<string>();
        if (set.has(uid)) return prev;
        const next = new Set(set);
        next.add(uid);
        return { ...prev, [convId]: next };
      });
      const key = `${convId}:${uid}`;
      const existing = typingTimers.current.get(key);
      if (existing) window.clearTimeout(existing);
      const t = window.setTimeout(() => {
        typingTimers.current.delete(key);
        clearTyping(convId, uid);
      }, 5000);
      typingTimers.current.set(key, t);
    },
    [clearTyping],
  );

  useEffect(() => {
    if (!user) {
      sockRef.current?.disconnect();
      sockRef.current = null;
      setConnectionStatus('disconnected');
      return;
    }
    setConnectionStatus('connecting');
    // Distribution mode: socket.io defaults its path to '/socket.io'. Under
    // multi-app (BASE_PATH=/connect) the upstream Caddy proxies the prefixed
    // path through, so we need '/connect/socket.io' on the wire. The empty
    // single-app prefix collapses to the default.
    const ioPath = `${getBoot().basePath}/socket.io`;
    const sock = io({
      path: ioPath,
      transports: ['websocket'],
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });
    sockRef.current = sock;

    sock.on('connect', () => {
      setConnectionStatus('connected');
      // A reconnect after an outage may have missed message/edit events — refresh the
      // conversation list and open message list so we rehydrate from server truth.
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['messages'] });
      // Any typing:start events we saw before the disconnect are now ghosts —
      // the 5s auto-expiry would clear them but leaves "…is typing" indicators
      // flashing after every reconnect. Wipe the map + pending expiry timers
      // on every fresh connect so the UI starts from a known-clean slate.
      setTypingByConversation({});
      for (const t of typingTimers.current.values()) window.clearTimeout(t);
      typingTimers.current.clear();
    });
    sock.on('disconnect', () => setConnectionStatus('reconnecting'));
    sock.io.on('reconnect_attempt', () => setConnectionStatus('reconnecting'));
    sock.io.on('reconnect_failed', () => setConnectionStatus('disconnected'));

    sock.on('message:new', (evt: { conversationId: string }) => {
      qc.invalidateQueries({ queryKey: ['messages', evt.conversationId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
      // Also refresh the conversation detail. If we missed a conversation:rekey
      // or wrapped-keys-updated event, this pulls the current rotationVersion +
      // wrappedKeysByVersion so the next send / decrypt sees accurate state.
      qc.invalidateQueries({ queryKey: ['conversation', evt.conversationId] });
    });
    sock.on('message:edit', (evt: { conversationId: string }) => {
      qc.invalidateQueries({ queryKey: ['messages', evt.conversationId] });
    });
    sock.on('message:delete', (evt: { conversationId: string }) => {
      qc.invalidateQueries({ queryKey: ['messages', evt.conversationId] });
    });
    sock.on('message:read', (_evt: { conversationId: string; userId: string | null }) => {
      // Any read receipt advances `last_read_message_id` → the sidebar's unread
      // count is stale, and the conversation view may want to re-render receipts.
      qc.invalidateQueries({ queryKey: ['conversations'] });
    });
    sock.on('conversation:rekey', (evt: { conversationId: string }) => {
      qc.invalidateQueries({ queryKey: ['conversation', evt.conversationId] });
    });
    sock.on('conversation:wrapped-keys-updated', (evt: { conversationId: string }) => {
      // A new sealed wrap landed for at least one member — most commonly a
      // device that just enrolled. Refetching the conversation detail lets the
      // missing device pick up its entry and decrypt.
      qc.invalidateQueries({ queryKey: ['conversation', evt.conversationId] });
      qc.invalidateQueries({ queryKey: ['messages', evt.conversationId] });
    });
    sock.on('request:changed', (evt: { conversationId: string; listId: string }) => {
      // Phase 24: a request_list or request_item changed for someone in this
      // conversation. Invalidate both the per-conversation lists query and
      // the specific list detail; whichever one the panel currently has
      // mounted will refetch.
      qc.invalidateQueries({ queryKey: ['request-lists', 'conv', evt.conversationId] });
      qc.invalidateQueries({ queryKey: ['request-list', evt.listId] });
    });
    sock.on('presence:update', () => {
      qc.invalidateQueries({ queryKey: ['users'] });
    });
    sock.on('typing:start', (evt: TypingEvent) => {
      if (evt.userId === user.id) return;
      markTyping(evt.conversationId, evt.userId);
    });
    sock.on('typing:stop', (evt: TypingEvent) => {
      clearTyping(evt.conversationId, evt.userId);
    });
    sock.on('device:revoked', (evt: { deviceId?: string }) => {
      // Only react when it's THIS device being revoked — a sibling device of
      // the same user being revoked shouldn't sign this tab out. The server
      // broadcasts to `user:${userId}` so every tab of the user sees every
      // revocation; we filter client-side.
      if (myDeviceId && evt?.deviceId && evt.deviceId !== myDeviceId) return;
      void (async () => {
        try {
          await wipeDeviceSecrets(user.id);
        } catch {
          /* best-effort wipe */
        }
        try {
          await SearchIndex.wipeAll();
        } catch {
          /* best-effort wipe */
        }
        try {
          await api.logout();
        } finally {
          // Hard navigation (not React Router) so the device-revoke wipe
          // also flushes any in-memory crypto state. Distribution-mode:
          // url() prepends BASE_PATH so multi-app mode lands at
          // /connect/login, not /login (which would 404 behind Caddy).
          window.location.assign(url('/login'));
        }
      })();
    });
    const capturedTimers = typingTimers.current;
    return () => {
      sock.disconnect();
      sockRef.current = null;
      for (const t of capturedTimers.values()) window.clearTimeout(t);
      capturedTimers.clear();
    };
  }, [user, qc, markTyping, clearTyping, myDeviceId]);

  const emitTyping = useCallback((conversationId: string, state: 'start' | 'stop') => {
    const sock = sockRef.current;
    if (!sock || !sock.connected) return;
    sock.emit(state === 'start' ? 'typing:start' : 'typing:stop', conversationId);
  }, []);

  const value = useMemo<RealtimeCtx>(
    () => ({
      socket: sockRef.current,
      typingByConversation,
      emitTyping,
      connectionStatus,
    }),
    [typingByConversation, emitTyping, connectionStatus],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRealtime(): RealtimeCtx {
  return useContext(Ctx);
}
