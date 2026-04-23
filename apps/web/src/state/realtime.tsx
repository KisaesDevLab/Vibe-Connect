/**
 * useRealtime — Socket.io client that invalidates TanStack Query caches when events fire.
 */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from './auth.js';

interface RealtimeCtx {
  socket: Socket | null;
}
const Ctx = createContext<RealtimeCtx>({ socket: null });

export function RealtimeProvider({ children }: { children: ReactNode }): JSX.Element {
  const { user } = useAuth();
  const qc = useQueryClient();
  const sockRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!user) {
      sockRef.current?.disconnect();
      sockRef.current = null;
      return;
    }
    const sock = io({ transports: ['websocket'], withCredentials: true });
    sockRef.current = sock;

    sock.on('message:new', (evt: { conversationId: string }) => {
      qc.invalidateQueries({ queryKey: ['messages', evt.conversationId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    });
    sock.on('message:edit', (evt: { conversationId: string }) => {
      qc.invalidateQueries({ queryKey: ['messages', evt.conversationId] });
    });
    sock.on('message:delete', (evt: { conversationId: string }) => {
      qc.invalidateQueries({ queryKey: ['messages', evt.conversationId] });
    });
    sock.on('conversation:rekey', (evt: { conversationId: string }) => {
      qc.invalidateQueries({ queryKey: ['conversation', evt.conversationId] });
    });
    sock.on('presence:update', () => {
      qc.invalidateQueries({ queryKey: ['users'] });
    });
    sock.on('device:revoked', () => {
      // TODO(phase13): hard-wipe local keys + force logout.
    });
    return () => {
      sock.disconnect();
      sockRef.current = null;
    };
  }, [user, qc]);

  const value = useMemo(() => ({ socket: sockRef.current }), []);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRealtime(): RealtimeCtx {
  return useContext(Ctx);
}
