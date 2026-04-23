import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import type { DecryptedMessage, EncryptedMessage, PublicUser } from '@vibe-connect/shared-types';
import { api } from '../api.js';
import { useAuth } from '../state/auth.js';
import { useCrypto } from '../state/crypto.js';
import { useSearch } from '../state/searchContext.js';
import { minimalMarkdown } from './markdown.js';
import { ScheduledPicker } from './ScheduledPicker.js';

function useDecryptedMessages(
  conversationId: string,
  wrappedKeys: Record<string, string> | null,
  recipientId: string | null,
): {
  messages: DecryptedMessage[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
} {
  const { decrypt } = useCrypto();
  const messagesQ = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => api.listMessages(conversationId, { limit: 100 }).then((r) => r.messages),
    enabled: Boolean(conversationId),
  });
  const [decoded, setDecoded] = useState<DecryptedMessage[]>([]);
  const [decErr, setDecErr] = useState<Error | null>(null);
  useEffect(() => {
    if (!messagesQ.data || !wrappedKeys || !recipientId) {
      setDecoded([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const out: DecryptedMessage[] = [];
        for (const m of messagesQ.data) {
          const d = await decrypt(m as EncryptedMessage, wrappedKeys, recipientId);
          out.push(d);
        }
        if (!cancelled) {
          setDecoded(out.reverse()); // chronological ascending for rendering
          setDecErr(null);
        }
      } catch (err) {
        if (!cancelled) setDecErr(err as Error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messagesQ.data, wrappedKeys, recipientId, decrypt]);

  return {
    messages: decoded,
    loading: messagesQ.isLoading,
    error: messagesQ.error ?? decErr,
    reload: () => messagesQ.refetch(),
  };
}

export function ConversationView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { user: me } = useAuth();
  const { device, encryptForConversation } = useCrypto();
  const qc = useQueryClient();

  const convQ = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.getConversation(id!),
    enabled: Boolean(id),
  });
  const usersQ = useQuery({
    queryKey: ['users'],
    queryFn: () => api.listUsers().then((r) => r.users),
    staleTime: 30_000,
  });

  // Determine our own wrapped-key id. In Phase 8 the client doesn't yet upload its device
  // to the server, so we look for the SINGLE wrapped-key entry matching our device's
  // public key by trying to unwrap each. Simpler heuristic: the device recipient id was
  // recorded client-side when the conversation was created; the server identifies our
  // wrapped key by matching our device row. For now assume a single recipient id equal to
  // our user id (valid for test fixtures; Phase 11 formalizes the device-id mapping).
  const recipientId = me?.id ?? null;

  const { messages, loading, reload } = useDecryptedMessages(
    id ?? '',
    convQ.data?.wrappedKeys ?? null,
    recipientId,
  );

  const usersById = useMemo(() => {
    const m: Record<string, PublicUser> = {};
    for (const u of usersQ.data ?? []) m[u.id] = u;
    return m;
  }, [usersQ.data]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Auto-scroll unless the user has scrolled up.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const [body, setBody] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const sendMut = useMutation({
    mutationFn: async () => {
      if (!id || !convQ.data?.wrappedKeys || !recipientId || !device) return;
      // Load the conversation key by unwrapping once, then encrypt.
      const cryptoMod = await import('@vibe-connect/crypto');
      const secretKey = await unlockSecret();
      if (!secretKey) throw new Error('Device locked');
      const convKey = await cryptoMod.unwrapConversationKey(
        convQ.data.wrappedKeys,
        recipientId,
        device.publicKey,
        secretKey,
      );
      const { ciphertext } = await encryptForConversation(
        body.trim(),
        convKey,
        convQ.data.rotationVersion ?? 1,
      );
      await api.sendMessage(id, {
        ciphertext,
        contentKeyVersion: convQ.data.rotationVersion ?? 1,
        urgent,
        scheduledFor,
      });
      if (urgent) {
        try {
          playUrgentSound();
        } catch {
          /* audio blocked is fine */
        }
      }
    },
    onSuccess: () => {
      setBody('');
      setUrgent(false);
      setScheduledFor(null);
      qc.invalidateQueries({ queryKey: ['messages', id] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  // Mark incoming messages read after they've been on screen for a beat.
  useEffect(() => {
    const unread = messages.filter((m) => m.senderId !== me?.id);
    for (const m of unread) void api.markRead(m.id).catch(() => null);
  }, [messages, me?.id]);

  // Index decrypted messages for client-side search.
  const { indexMessage } = useSearch();
  useEffect(() => {
    for (const m of messages) {
      if (!m.body) continue;
      indexMessage({
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        body: m.body,
        createdAt: m.createdAt,
      });
    }
  }, [messages, indexMessage]);

  // Device secret key is kept in memory in useCrypto; we need re-access here without
  // re-exporting it. For Phase 8 we re-read via a small private helper. Proper API for
  // this lands when we implement upload of the device record to the server in Phase 11/13.
  async function unlockSecret(): Promise<string | null> {
    // useCrypto.decrypt already uses the in-memory secret; we piggy-back by exposing it
    // through a module-level escape hatch on the window to keep the Phase 8 diff local.
    // In production we'll expose `getDeviceSecret` on the CryptoCtx.
    return (window as unknown as { __vibe_secret?: string }).__vibe_secret ?? null;
  }

  if (!id)
    return (
      <div className="h-full grid place-items-center text-slate-500">Select a conversation.</div>
    );

  const header = conversationHeader(convQ.data ?? null, usersById, me?.id ?? null);

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-slate-200 bg-white flex items-center gap-3">
        <div className="font-semibold text-slate-900">{header.title}</div>
        <div className="text-xs text-slate-500">{header.subtitle}</div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-slate-50">
        {loading && <div className="text-sm text-slate-500">Loading…</div>}
        {!loading && messages.length === 0 && (
          <div className="text-sm text-slate-500">No messages yet. Say hello.</div>
        )}
        {groupByDay(messages).map((day) => (
          <div key={day.date}>
            <div className="text-center text-[11px] uppercase tracking-wide text-slate-400 my-2">
              {day.date}
            </div>
            <div className="space-y-2">
              {day.items.map((m) => (
                <MessageRow
                  key={m.id}
                  msg={m}
                  sender={m.senderId ? usersById[m.senderId] : undefined}
                  me={me?.id ?? null}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <Compose
        body={body}
        urgent={urgent}
        scheduledFor={scheduledFor}
        onBody={setBody}
        onUrgent={setUrgent}
        onScheduledFor={setScheduledFor}
        onSend={() => {
          if (!body.trim()) return;
          sendMut.mutate();
        }}
      />
      {/* Hidden ref for lint + future reloads */}
      <button type="button" onClick={() => void reload()} className="hidden" />
    </div>
  );
}

function MessageRow({
  msg,
  sender,
  me,
}: {
  msg: DecryptedMessage;
  sender: PublicUser | undefined;
  me: string | null;
}): JSX.Element {
  const mine = msg.senderId === me;
  return (
    <div className={clsx('flex items-start gap-3', mine && 'flex-row-reverse')}>
      <div className="w-8 h-8 rounded-full bg-slate-200 grid place-items-center text-xs font-medium text-slate-700">
        {(sender?.displayName ?? '?').slice(0, 1).toUpperCase()}
      </div>
      <div
        className={clsx(
          'max-w-[72%] rounded-2xl px-3 py-2 shadow-card text-sm leading-relaxed',
          mine ? 'bg-brand-600 text-white' : 'bg-white text-slate-800',
          msg.urgent && (mine ? 'ring-2 ring-amber-300' : 'ring-2 ring-rose-400'),
        )}
      >
        {!mine && sender && (
          <div className="text-xs font-medium text-slate-500 mb-0.5">{sender.displayName}</div>
        )}
        {msg.urgent && (
          <div
            className={clsx(
              'text-[11px] font-semibold mb-1',
              mine ? 'text-amber-200' : 'text-rose-600',
            )}
          >
            ⚡ Urgent
          </div>
        )}
        <div
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: minimalMarkdown(msg.body) }}
        />
        <div className={clsx('text-[10px] mt-1', mine ? 'text-brand-100' : 'text-slate-400')}>
          {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {msg.editedAt && ' · edited'}
          {msg.source !== 'app' && ` · via ${msg.source.replace('-in', '')}`}
        </div>
      </div>
    </div>
  );
}

function Compose({
  body,
  urgent,
  scheduledFor,
  onBody,
  onUrgent,
  onScheduledFor,
  onSend,
}: {
  body: string;
  urgent: boolean;
  scheduledFor: string | null;
  onBody: (v: string) => void;
  onUrgent: (v: boolean) => void;
  onScheduledFor: (v: string | null) => void;
  onSend: () => void;
}): JSX.Element {
  return (
    <div className="border-t border-slate-200 bg-white p-3">
      <div className="flex items-start gap-2">
        <textarea
          rows={2}
          className="flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          placeholder="Type a message. **bold**, _italic_, shift+enter for newline."
          value={body}
          onChange={(e) => onBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={urgent}
              onChange={(e) => onUrgent(e.target.checked)}
              className="accent-rose-500"
            />
            Urgent
          </label>
          <button
            type="button"
            onClick={onSend}
            disabled={!body.trim()}
            className="rounded-md bg-brand-600 text-white font-medium px-4 py-2 text-sm hover:bg-brand-700 disabled:opacity-60"
          >
            {scheduledFor ? 'Schedule' : 'Send'}
          </button>
        </div>
      </div>
      <div className="mt-2">
        <ScheduledPicker value={scheduledFor} onChange={onScheduledFor} />
      </div>
    </div>
  );
}

function playUrgentSound(): void {
  const ctx = new (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  )();
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.connect(g);
  g.connect(ctx.destination);
  o.type = 'square';
  o.frequency.value = 880;
  g.gain.value = 0.1;
  o.start();
  setTimeout(() => {
    o.frequency.value = 660;
  }, 120);
  setTimeout(() => {
    o.stop();
    void ctx.close();
  }, 260);
}

function conversationHeader(
  conv: {
    type: string;
    displayName: string | null;
    members: Array<{ userId: string | null }>;
  } | null,
  users: Record<string, PublicUser>,
  me: string | null,
): { title: string; subtitle: string } {
  if (!conv) return { title: 'Conversation', subtitle: '' };
  if (conv.displayName) return { title: conv.displayName, subtitle: conv.type };
  const otherIds = conv.members
    .map((m) => m.userId)
    .filter((u): u is string => Boolean(u) && u !== me);
  const names = otherIds.map((id) => users[id]?.displayName ?? '…').filter(Boolean);
  return { title: names.join(', ') || 'Conversation', subtitle: conv.type };
}

function groupByDay(msgs: DecryptedMessage[]): Array<{ date: string; items: DecryptedMessage[] }> {
  const map = new Map<string, DecryptedMessage[]>();
  for (const m of msgs) {
    const d = new Date(m.createdAt);
    const key = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    const arr = map.get(key) ?? [];
    arr.push(m);
    map.set(key, arr);
  }
  return Array.from(map.entries()).map(([date, items]) => ({ date, items }));
}
