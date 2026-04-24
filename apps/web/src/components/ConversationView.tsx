import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import type { SymmetricEnvelope } from '@vibe-connect/crypto';
import type { DecryptedMessage, EncryptedMessage, PublicUser } from '@vibe-connect/shared-types';
import { api } from '../api.js';
import { useAuth } from '../state/auth.js';
import { useCrypto } from '../state/crypto.js';
import { useRealtime } from '../state/realtime.js';
import { useSearch } from '../state/searchContext.js';
import { highlightQueryInHtml, minimalMarkdown } from './markdown.js';
import { ScheduledPicker } from './ScheduledPicker.js';

function useDecryptedMessages(
  conversationId: string,
  wrappedKeys: Record<string, string> | null,
  recipientId: string | null,
  wrappedKeysByVersion: Record<string, Record<string, string>> | null,
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
    if (!messagesQ.data || !recipientId) {
      setDecoded([]);
      return;
    }
    if (!wrappedKeys && !wrappedKeysByVersion) {
      setDecoded([]);
      return;
    }
    let cancelled = false;
    (async () => {
      // Per-message tolerance: one failed decrypt (e.g. a rotation-version
      // skew, a bridged message this device isn't keyed for) used to blank
      // the entire list. Now we render each message individually, showing a
      // placeholder body for the ones that can't open so the rest stay
      // readable and new messages still appear when they arrive.
      const out: DecryptedMessage[] = [];
      let anyError: Error | null = null;
      for (const m of messagesQ.data) {
        try {
          const d = await decrypt(
            m as EncryptedMessage,
            wrappedKeys,
            recipientId,
            wrappedKeysByVersion,
          );
          out.push(d);
        } catch (err) {
          anyError = err instanceof Error ? err : new Error(String(err));
          out.push({
            id: m.id,
            conversationId: m.conversationId,
            senderId: m.senderId,
            senderExternalIdentityId: m.senderExternalIdentityId,
            body: '(unable to decrypt on this device)',
            urgent: m.urgent,
            scheduledFor: m.scheduledFor,
            source: m.source,
            createdAt: m.createdAt,
            editedAt: m.editedAt,
            deletedAt: m.deletedAt,
            attachments: [],
          });
        }
      }
      if (!cancelled) {
        setDecoded(out.reverse()); // chronological ascending for rendering
        setDecErr(anyError);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messagesQ.data, wrappedKeys, wrappedKeysByVersion, recipientId, decrypt]);

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
  const { device, encryptForConversation, getSecretKey, recipientId: getRecipientId } = useCrypto();
  const { socket, typingByConversation, emitTyping } = useRealtime();
  const qc = useQueryClient();

  // Join the conversation room so the server routes typing + read events to us.
  useEffect(() => {
    if (!socket || !id) return;
    socket.emit('conversation:join', id);
    return () => {
      socket.emit('conversation:leave', id);
    };
  }, [socket, id]);

  const convQ = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.getConversation(id!),
    enabled: Boolean(id),
    // While this device is waiting for its wrapped-keys entry to arrive from
    // another of my devices (rewrap-after-enroll), poll every 5s as a fallback
    // in case the realtime wrapped-keys-updated event is missed. `recipientId`
    // is evaluated at render time below — this query doesn't know about it
    // yet, so we lean on the refetchInterval seeing the latest state.
    refetchInterval: (query) => {
      const data = query.state.data as { wrappedKeys: Record<string, string> | null } | undefined;
      if (!data || data.wrappedKeys === null) return false;
      const rid = getRecipientId();
      if (!rid) return false;
      return rid in data.wrappedKeys ? false : 5000;
    },
    refetchIntervalInBackground: false,
  });
  const usersQ = useQuery({
    queryKey: ['users'],
    queryFn: () => api.listUsers(),
    staleTime: 30_000,
  });

  // Conversation keys are wrapped per-device as `${userId}:${deviceId}`. Sidebar's
  // start-DM + ad-hoc-group flows use the same shape so this resolves to our entry.
  const recipientId = getRecipientId();

  const { messages, loading, reload } = useDecryptedMessages(
    id ?? '',
    convQ.data?.wrappedKeys ?? null,
    recipientId,
    convQ.data?.wrappedKeysByVersion ?? null,
  );

  const usersById = useMemo(() => {
    const m: Record<string, PublicUser> = {};
    for (const u of usersQ.data?.users ?? []) m[u.id] = u;
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
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  // In-thread filter. Runs against the already-decrypted messages in memory —
  // we don't hit the FlexSearch index here because (a) the visible list is
  // small and a substring match is instant, and (b) the index's purpose is
  // cross-conversation "find anything I've ever read", not within-thread
  // narrowing. Stay case-insensitive; ignore empty / whitespace queries.
  const [searchQuery, setSearchQuery] = useState('');
  const [uploadState, setUploadState] = useState<
    'idle' | 'encrypting' | 'uploading' | 'done' | 'infected' | 'blocked' | 'scanUnavailable'
  >('idle');
  const [uploadDetail, setUploadDetail] = useState<string | null>(null);

  // Typing indicator emission. Emit `start` at most every 3s while the user is typing,
  // and `stop` 2s after the last keystroke or immediately on send/leave.
  const lastTypingStartRef = useRef(0);
  const typingStopTimerRef = useRef<number | null>(null);
  const scheduleTypingStop = useCallback(() => {
    if (!id) return;
    if (typingStopTimerRef.current) window.clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = window.setTimeout(() => {
      emitTyping(id, 'stop');
      lastTypingStartRef.current = 0;
      typingStopTimerRef.current = null;
    }, 2000);
  }, [id, emitTyping]);
  const onBodyChange = useCallback(
    (v: string) => {
      setBody(v);
      if (!id) return;
      if (v.length === 0) {
        if (typingStopTimerRef.current) window.clearTimeout(typingStopTimerRef.current);
        typingStopTimerRef.current = null;
        if (lastTypingStartRef.current > 0) {
          emitTyping(id, 'stop');
          lastTypingStartRef.current = 0;
        }
        return;
      }
      const now = Date.now();
      if (now - lastTypingStartRef.current > 3000) {
        emitTyping(id, 'start');
        lastTypingStartRef.current = now;
      }
      scheduleTypingStop();
    },
    [id, emitTyping, scheduleTypingStop],
  );
  useEffect(() => {
    return () => {
      // Leaving the conversation → clear any pending stop timer and announce stop.
      if (typingStopTimerRef.current) window.clearTimeout(typingStopTimerRef.current);
      if (id && lastTypingStartRef.current > 0) emitTyping(id, 'stop');
    };
  }, [id, emitTyping]);

  const typingUserIds = id ? Array.from(typingByConversation[id] ?? []) : [];

  const sendMut = useMutation({
    mutationFn: async () => {
      if (!id || !convQ.data?.wrappedKeys || !recipientId || !device) return;
      const secretKey = getSecretKey();
      if (!secretKey) throw new Error('Device locked');
      const cryptoMod = await import('@vibe-connect/crypto');
      const convKey = await cryptoMod.unwrapConversationKey(
        convQ.data.wrappedKeys,
        recipientId,
        device.publicKey,
        secretKey,
      );
      const version = convQ.data.rotationVersion ?? 1;
      // Pick the body: prefer the typed text, else fall back to filename marker so
      // message lists aren't empty for attachment-only sends.
      const textBody =
        body.trim() ||
        (pendingFile ? `📎 ${pendingFile.name}` : '');
      const { ciphertext } = await encryptForConversation(textBody, convKey, version);
      // Generate a fresh idempotency key per send. If the network call times out and the
      // user retries, the server suppresses the duplicate and returns the original id.
      const idempotencyKey =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const sent = await api.sendMessage(
        id,
        { ciphertext, contentKeyVersion: version, urgent, scheduledFor },
        { idempotencyKey },
      );
      if (urgent) {
        try {
          playUrgentSound();
        } catch {
          /* audio blocked is fine */
        }
      }
      if (pendingFile) {
        setUploadDetail(null);
        setUploadState('encrypting');
        try {
          const bytes = new Uint8Array(await pendingFile.arrayBuffer());
          const fileKey = await cryptoMod.generateSymmetricKey();
          const envelope = await cryptoMod.encryptMessage(bytes, fileKey, version);
          // File key wrapped to the conversation key; any member can unwrap.
          const wrappedFileKey = await cryptoMod.secretboxEncrypt(fileKey, convKey);
          const filenameCiphertext = await cryptoMod.secretboxEncrypt(
            cryptoMod.utf8Encode(pendingFile.name),
            convKey,
          );
          const ciphertextBytes = cryptoMod.utf8Encode(JSON.stringify(envelope));
          // Copy into a fresh ArrayBuffer so Blob's BlobPart type (which rejects
          // SharedArrayBuffer-backed views from libsodium) is happy.
          const copy = new Uint8Array(ciphertextBytes.byteLength);
          copy.set(ciphertextBytes);
          setUploadState('uploading');
          const result = await api.uploadAttachment(id, {
            messageId: sent.id,
            filenameCiphertext,
            wrappedFileKey,
            mimeType: pendingFile.type || 'application/octet-stream',
            ciphertext: new Blob([copy], { type: 'application/octet-stream' }),
          });
          setUploadState(result.scanStatus === 'infected' ? 'infected' : 'done');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const status = (err as { status?: number })?.status;
          if (msg.startsWith('infected')) {
            setUploadDetail(msg.replace(/^infected:?\s*/, ''));
            setUploadState('infected');
          } else if (status === 503) {
            // conversations.ts returns 503 scan_unavailable when ClamAV can't
            // reach a verdict. Fail-closed: the caller should retry.
            setUploadDetail(null);
            setUploadState('scanUnavailable');
          } else {
            setUploadDetail(msg);
            setUploadState('blocked');
          }
        }
      }
    },
    onSuccess: () => {
      setBody('');
      setUrgent(false);
      setScheduledFor(null);
      setPendingFile(null);
      if (id && lastTypingStartRef.current > 0) {
        emitTyping(id, 'stop');
        lastTypingStartRef.current = 0;
      }
      if (typingStopTimerRef.current) window.clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = null;
      qc.invalidateQueries({ queryKey: ['messages', id] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  /**
   * Download + decrypt an attachment to plaintext bytes. Used by both the
   * "save to disk" flow and the inline image preview — separated so the
   * preview path doesn't synthesize an invisible <a> click.
   */
  async function decryptAttachmentBytes(att: {
    id: string;
    wrappedFileKey: string;
    contentKeyVersion: number;
  }): Promise<Uint8Array | null> {
    if (!recipientId || !device) return null;
    const secretKey = getSecretKey();
    if (!secretKey) throw new Error('Device locked');
    // Pick the wrapped_keys for the attachment's own rotation version — a
    // file uploaded before a rotation is keyed to the old conversation key.
    const versionKey = String(att.contentKeyVersion);
    const keysForVersion =
      convQ.data?.wrappedKeysByVersion?.[versionKey] ?? convQ.data?.wrappedKeys ?? null;
    if (!keysForVersion) return null;
    const cryptoMod = await import('@vibe-connect/crypto');
    const convKey = await cryptoMod.unwrapConversationKey(
      keysForVersion,
      recipientId,
      device.publicKey,
      secretKey,
    );
    const fileKey = await cryptoMod.secretboxDecrypt(att.wrappedFileKey, convKey);
    const cipherBuf = await api.downloadAttachment(att.id);
    const envelope = JSON.parse(
      cryptoMod.utf8Decode(new Uint8Array(cipherBuf)),
    ) as SymmetricEnvelope;
    const plain = await cryptoMod.decryptMessage(envelope, fileKey);
    const plainCopy = new Uint8Array(plain.byteLength);
    plainCopy.set(plain);
    return plainCopy;
  }

  async function downloadAttachment(
    att: {
      id: string;
      filename: string;
      wrappedFileKey: string;
      mimeType: string;
      contentKeyVersion: number;
    },
  ): Promise<void> {
    const bytes = await decryptAttachmentBytes(att);
    if (!bytes) return;
    const blob = bytesToBlob(bytes, att.mimeType);
    triggerBrowserDownload(blob, att.filename || 'attachment');
  }

  /**
   * Convert a single image attachment to a one-page PDF and trigger a
   * browser download. Used by the per-image "PDF" button on image previews.
   * Falls through silently if decrypt fails — the caller's onDownload (raw
   * image) is still wired, so the user has a working fallback path.
   */
  async function downloadImageAsPdf(
    att: {
      id: string;
      filename: string;
      wrappedFileKey: string;
      mimeType: string;
      contentKeyVersion: number;
    },
  ): Promise<void> {
    const bytes = await decryptAttachmentBytes(att);
    if (!bytes) return;
    const { imagesToPdf } = await import('../lib/imageToPdf.js');
    const pdfBytes = await imagesToPdf([{ bytes, mimeType: att.mimeType }]);
    const blob = bytesToBlob(pdfBytes, 'application/pdf');
    triggerBrowserDownload(blob, pdfFilenameForImage(att.filename));
  }

  /**
   * Combine every eligible image attachment on a message into one PDF. Each
   * image gets its own page. Decryption is sequential on purpose — the
   * global rate limiter caps at 600 req/min per IP, and a parallel burst on
   * a message with many images would trip it and leave the user worse off
   * than simply waiting. Sequential also keeps peak RSS at one-image-worth
   * of plaintext plus the accumulating PDF buffer.
   */
  async function downloadMessageImagesAsPdf(msg: DecryptedMessage): Promise<void> {
    const { isPdfConvertible, imagesToPdf } = await import('../lib/imageToPdf.js');
    const eligible = msg.attachments.filter(
      (a) =>
        a.scanStatus === 'clean' &&
        isPdfConvertible(a.mimeType) &&
        a.sizeBytes <= INLINE_IMAGE_SIZE_CAP,
    );
    if (eligible.length === 0) return;
    const totalBytes = eligible.reduce((sum, a) => sum + a.sizeBytes, 0);
    if (totalBytes > COMBINED_PDF_SIZE_CAP) {
      // eslint-disable-next-line no-alert
      alert(
        `Combined PDF would be ~${Math.round(totalBytes / 1024 / 1024)} MB. Save images individually instead.`,
      );
      return;
    }
    const images: Array<{ bytes: Uint8Array; mimeType: string }> = [];
    for (const att of eligible) {
      try {
        const bytes = await decryptAttachmentBytes({
          id: att.id,
          wrappedFileKey: att.wrappedFileKey,
          contentKeyVersion: att.contentKeyVersion,
        });
        if (bytes) images.push({ bytes, mimeType: att.mimeType });
      } catch {
        // Skip unreadable images; the rest still make a partial PDF.
      }
    }
    if (images.length === 0) return;
    const pdfBytes = await imagesToPdf(images);
    const blob = bytesToBlob(pdfBytes, 'application/pdf');
    const datePart = new Date(msg.createdAt).toISOString().slice(0, 10);
    triggerBrowserDownload(blob, `attachments-${datePart}.pdf`);
  }

  // Mark the most recent message as read — the server's unread count is a
  // strict "newer than last_read_message_id" comparison, so advancing the
  // pointer to the latest message by timestamp clears everything before it,
  // including self-authored messages. One POST per conversation open, not N.
  useEffect(() => {
    if (messages.length === 0) return;
    const newest = messages.reduce((acc, m) =>
      new Date(m.createdAt).getTime() > new Date(acc.createdAt).getTime() ? m : acc,
    );
    void api
      .markRead(newest.id)
      .catch(() => null)
      .then(() => qc.invalidateQueries({ queryKey: ['conversations'] }));
  }, [messages, qc]);

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

  // Must sit above the `if (!id) return` early-return so Hook order stays
  // stable across renders (react-hooks/rules-of-hooks).
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const filteredMessages = useMemo(() => {
    if (!trimmedQuery) return messages;
    return messages.filter((m) => (m.body ?? '').toLowerCase().includes(trimmedQuery));
  }, [messages, trimmedQuery]);

  if (!id)
    return (
      <div className="h-full grid place-items-center text-slate-500">Select a conversation.</div>
    );

  const header = conversationHeader(convQ.data ?? null, usersById, me?.id ?? null);

  // If my device isn't in wrappedKeys yet, the conversation key hasn't been
  // rewrapped to this browser/machine. Messages can't decrypt and I can't
  // encrypt new ones. Surface this clearly instead of silently showing zero
  // messages — and disable send so users aren't left wondering why nothing
  // happens. The rewrap fires automatically from any other already-enrolled
  // device of any member; once it lands, the wrapped-keys-updated socket
  // event invalidates this query and decrypt just starts working.
  const convKeysLoaded = Boolean(convQ.data);
  const waitingForSync =
    convKeysLoaded &&
    recipientId !== null &&
    convQ.data!.wrappedKeys !== null &&
    !(recipientId in (convQ.data!.wrappedKeys ?? {}));

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-slate-200 bg-white flex items-center gap-3">
        <div className="font-semibold text-slate-900">{header.title}</div>
        <div className="text-xs text-slate-500">{header.subtitle}</div>
        <PresenceDot status={header.presence} />
        <div className="ml-auto flex items-center gap-2">
          <label className="relative flex items-center">
            <svg
              className="absolute left-2 w-3.5 h-3.5 text-slate-400 pointer-events-none"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && searchQuery) {
                  e.preventDefault();
                  setSearchQuery('');
                }
              }}
              placeholder="Find in conversation"
              aria-label="Find in conversation"
              className="pl-7 pr-2 py-1 text-xs w-40 rounded border border-slate-300 focus:border-brand-500 focus:outline-none"
            />
          </label>
          {trimmedQuery && (
            <span className="text-[11px] text-slate-500 whitespace-nowrap">
              {filteredMessages.length === 0
                ? 'No matches'
                : `${filteredMessages.length} of ${messages.length}`}
            </span>
          )}
        </div>
      </div>

      {waitingForSync && <SyncBanner />}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-slate-50">
        {loading && <div className="text-sm text-slate-500">Loading…</div>}
        {!loading && !waitingForSync && messages.length === 0 && (
          <div className="text-sm text-slate-500">No messages yet. Say hello.</div>
        )}
        {!loading && !waitingForSync && trimmedQuery && filteredMessages.length === 0 &&
          messages.length > 0 && (
            <div className="text-sm text-slate-500">
              No messages match &ldquo;{searchQuery}&rdquo; in this conversation.
            </div>
          )}
        {groupByDay(filteredMessages).map((day) => (
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
                  onDownloadAttachment={(a) => void downloadAttachment(a)}
                  onDownloadAttachmentAsPdf={(a) => void downloadImageAsPdf(a)}
                  onDownloadMessageAsPdf={(m2) => void downloadMessageImagesAsPdf(m2)}
                  decryptAttachmentBytes={decryptAttachmentBytes}
                  highlight={trimmedQuery || null}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <TypingBanner userIds={typingUserIds} usersById={usersById} meId={me?.id ?? null} />

      <Compose
        body={body}
        urgent={urgent}
        scheduledFor={scheduledFor}
        pendingFile={pendingFile}
        uploadState={uploadState}
        uploadDetail={uploadDetail}
        disabled={waitingForSync}
        disabledReason={
          waitingForSync
            ? 'This device is still syncing. Sending is disabled until another of your devices rewraps the conversation key for this one.'
            : null
        }
        mentionCandidates={(convQ.data?.members ?? [])
          .map((m) => (m.userId ? usersById[m.userId] : undefined))
          .filter((u): u is PublicUser => u !== undefined && u.id !== me?.id)}
        onBody={onBodyChange}
        onUrgent={setUrgent}
        onScheduledFor={setScheduledFor}
        onPickFile={(f) => {
          setPendingFile(f);
          setUploadState('idle');
          setUploadDetail(null);
        }}
        onSend={() => {
          if (!body.trim() && !pendingFile) return;
          sendMut.mutate();
        }}
      />
      {/* Hidden ref for lint + future reloads */}
      <button type="button" onClick={() => void reload()} className="hidden" />
    </div>
  );
}

function SyncBanner(): JSX.Element {
  const [pending, setPending] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  return (
    <div className="bg-amber-50 border-b border-amber-200 text-amber-900 text-sm px-4 py-2 flex items-center gap-3">
      <div className="flex-1">
        <strong>This device is syncing.</strong> History for this conversation was encrypted
        before this browser/machine was enrolled, so it can&apos;t be read yet. Keep another of
        your signed-in devices online + unlocked — as soon as it processes the sync, messages
        will appear automatically.
        {info && <span className="ml-2 text-amber-800">{info}</span>}
      </div>
      <button
        type="button"
        disabled={pending}
        className="rounded-md border border-amber-300 bg-white text-amber-900 text-xs font-medium px-3 py-1.5 hover:bg-amber-100 disabled:opacity-60"
        onClick={() => {
          setPending(true);
          setInfo(null);
          api
            .requestDeviceSync()
            .then(() => {
              setInfo('Sync requested — waiting for another device to respond…');
            })
            .catch((err: Error) => setInfo(`Failed: ${err.message}`))
            .finally(() => setPending(false));
        }}
      >
        {pending ? 'Requesting…' : 'Sync this device'}
      </button>
    </div>
  );
}

function TypingBanner({
  userIds,
  usersById,
  meId,
}: {
  userIds: string[];
  usersById: Record<string, PublicUser>;
  meId: string | null;
}): JSX.Element | null {
  const others = userIds.filter((uid) => uid !== meId);
  if (others.length === 0) return null;
  const names = others.map((uid) => usersById[uid]?.displayName ?? 'someone');
  const text =
    names.length === 1
      ? `${names[0]} is typing…`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing…`
        : `${names[0]} and ${others.length - 1} others are typing…`;
  return (
    <div className="px-4 py-1 text-xs text-slate-500 bg-slate-50 italic">{text}</div>
  );
}

function MessageRow({
  msg,
  sender,
  me,
  onDownloadAttachment,
  onDownloadAttachmentAsPdf,
  onDownloadMessageAsPdf,
  decryptAttachmentBytes,
  highlight,
}: {
  msg: DecryptedMessage;
  sender: PublicUser | undefined;
  me: string | null;
  onDownloadAttachment: (a: {
    id: string;
    filename: string;
    wrappedFileKey: string;
    mimeType: string;
    contentKeyVersion: number;
  }) => void;
  onDownloadAttachmentAsPdf: (a: {
    id: string;
    filename: string;
    wrappedFileKey: string;
    mimeType: string;
    contentKeyVersion: number;
  }) => void;
  onDownloadMessageAsPdf: (m: DecryptedMessage) => void;
  decryptAttachmentBytes: (a: {
    id: string;
    wrappedFileKey: string;
    contentKeyVersion: number;
  }) => Promise<Uint8Array | null>;
  /** Active in-thread search term. When set, matches are wrapped in <mark>. */
  highlight?: string | null;
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
        {msg.source !== 'app' && msg.source !== 'system' && (
          // BRIDGE: bridged-in messages are NOT end-to-end — they arrived in
          // plaintext via email/SMS and were sealed server-side. CLAUDE.md
          // requires a visible indicator; the bubble also gets an amber ring
          // so the non-E2EE origin is legible at a glance, not buried in the
          // timestamp row.
          <div
            className={clsx(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold mb-1',
              mine ? 'bg-amber-400/30 text-amber-50' : 'bg-amber-100 text-amber-900',
            )}
            title="This message arrived via email or SMS and is not end-to-end encrypted."
          >
            <span aria-hidden="true">{msg.source === 'email-in' ? '✉' : '💬'}</span>
            <span>Bridged {msg.source === 'email-in' ? 'email' : 'SMS'}</span>
          </div>
        )}
        {msg.body && (
          <div
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{
              __html: highlight
                ? highlightQueryInHtml(minimalMarkdown(msg.body), highlight)
                : minimalMarkdown(msg.body),
            }}
          />
        )}
        {msg.attachments.length > 0 && (
          <div className={clsx('mt-1 space-y-1', msg.body && 'pt-2 border-t', mine ? 'border-brand-500' : 'border-slate-200')}>
            {msg.attachments.map((a) => (
              <AttachmentView
                key={a.id}
                attachment={a}
                mine={mine}
                onDownload={() =>
                  onDownloadAttachment({
                    id: a.id,
                    filename: a.filename,
                    wrappedFileKey: a.wrappedFileKey,
                    mimeType: a.mimeType,
                    contentKeyVersion: a.contentKeyVersion,
                  })
                }
                onDownloadAsPdf={() =>
                  onDownloadAttachmentAsPdf({
                    id: a.id,
                    filename: a.filename,
                    wrappedFileKey: a.wrappedFileKey,
                    mimeType: a.mimeType,
                    contentKeyVersion: a.contentKeyVersion,
                  })
                }
                decryptAttachmentBytes={decryptAttachmentBytes}
              />
            ))}
            <MessageCombinePdfButton msg={msg} mine={mine} onCombine={() => onDownloadMessageAsPdf(msg)} />
          </div>
        )}
        <div className={clsx('text-[10px] mt-1', mine ? 'text-brand-100' : 'text-slate-400')}>
          {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {msg.editedAt && ' · edited'}
        </div>
      </div>
    </div>
  );
}

type AttachmentForRender = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  wrappedFileKey: string;
  contentKeyVersion: number;
  scanStatus: 'pending' | 'clean' | 'infected';
};

// Files above this size render as the plain chip even when they're images.
// Decrypting a 100 MB JPEG inline would burn CPU on every conversation open
// and leak memory via the object URL until the bubble unmounts. The user can
// still click the chip to download.
const INLINE_IMAGE_SIZE_CAP = 10 * 1024 * 1024;

/**
 * Below-the-attachments "Save all N images as one PDF" action. Shown only
 * when a message has two or more eligible images — a single-image message
 * already has the per-image PDF button on its preview, and a mixed message
 * with one image + some non-images would look weird offering "save all"
 * that secretly only bundles the one image.
 */
function MessageCombinePdfButton({
  msg,
  mine,
  onCombine,
}: {
  msg: DecryptedMessage;
  mine: boolean;
  onCombine: () => void;
}): JSX.Element | null {
  const eligible = msg.attachments.filter(
    (a) =>
      a.scanStatus === 'clean' &&
      isPdfConvertibleInline(a.mimeType) &&
      a.sizeBytes <= INLINE_IMAGE_SIZE_CAP,
  );
  if (eligible.length < 2) return null;
  return (
    <button
      type="button"
      onClick={onCombine}
      className={clsx(
        'block w-full text-left text-[11px] px-2 py-1 rounded-md hover:underline',
        mine ? 'bg-brand-500/20 text-brand-50 hover:bg-brand-500/40' : 'bg-slate-50 text-slate-600 hover:bg-slate-100',
      )}
      title={`Combine ${eligible.length} images into a single PDF`}
    >
      📄 Save all {eligible.length} images as one PDF
    </button>
  );
}

/**
 * Chooses between an inline image preview and the plain download chip.
 * Image preview is gated on: mimeType image/*, scanStatus clean, size cap,
 * and a successful client-side decrypt. Any failure (decrypt error, non-image
 * file, pending/infected scan, oversize) falls back to the chip so the user
 * always has a path to the bytes.
 */
function AttachmentView({
  attachment,
  mine,
  onDownload,
  onDownloadAsPdf,
  decryptAttachmentBytes,
}: {
  attachment: AttachmentForRender;
  mine: boolean;
  onDownload: () => void;
  onDownloadAsPdf: () => void;
  decryptAttachmentBytes: (a: {
    id: string;
    wrappedFileKey: string;
    contentKeyVersion: number;
  }) => Promise<Uint8Array | null>;
}): JSX.Element {
  const canPreview =
    attachment.scanStatus === 'clean' &&
    attachment.mimeType.startsWith('image/') &&
    attachment.sizeBytes <= INLINE_IMAGE_SIZE_CAP;
  if (canPreview) {
    return (
      <AttachmentImagePreview
        attachment={attachment}
        mine={mine}
        onDownload={onDownload}
        onDownloadAsPdf={onDownloadAsPdf}
        decryptAttachmentBytes={decryptAttachmentBytes}
      />
    );
  }
  return <AttachmentChip attachment={attachment} mine={mine} onDownload={onDownload} />;
}

function AttachmentImagePreview({
  attachment,
  mine,
  onDownload,
  onDownloadAsPdf,
  decryptAttachmentBytes,
}: {
  attachment: AttachmentForRender;
  mine: boolean;
  onDownload: () => void;
  onDownloadAsPdf: () => void;
  decryptAttachmentBytes: (a: {
    id: string;
    wrappedFileKey: string;
    contentKeyVersion: number;
  }) => Promise<Uint8Array | null>;
}): JSX.Element {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    (async () => {
      try {
        const bytes = await decryptAttachmentBytes({
          id: attachment.id,
          wrappedFileKey: attachment.wrappedFileKey,
          contentKeyVersion: attachment.contentKeyVersion,
        });
        if (cancelled) return;
        if (!bytes) {
          setState('error');
          return;
        }
        const blob = bytesToBlob(bytes, attachment.mimeType);
        createdUrl = URL.createObjectURL(blob);
        setUrl(createdUrl);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
      // Revoke on unmount so we don't leak blob URLs for the life of the tab.
      // A small timeout gives the browser time to finish painting the <img>
      // if the component unmounts in the same tick as it mounts.
      if (createdUrl) setTimeout(() => URL.revokeObjectURL(createdUrl!), 0);
    };
  }, [
    attachment.id,
    attachment.mimeType,
    attachment.wrappedFileKey,
    attachment.contentKeyVersion,
    decryptAttachmentBytes,
  ]);

  if (state === 'error') {
    // Fall through to the chip so the user still has a way to grab the file.
    return <AttachmentChip attachment={attachment} mine={mine} onDownload={onDownload} />;
  }
  return (
    <figure className={clsx('rounded-md overflow-hidden', mine ? 'bg-brand-500/40' : 'bg-slate-100')}>
      <button
        type="button"
        onClick={onDownload}
        className="block w-full"
        title={`Download ${attachment.filename || 'image'}`}
      >
        {state === 'loading' || !url ? (
          <div className="aspect-[4/3] max-h-64 grid place-items-center text-xs opacity-70">
            Decrypting…
          </div>
        ) : (
          <img
            src={url}
            alt={attachment.filename || 'attachment'}
            className="max-h-64 max-w-full object-contain"
            loading="lazy"
          />
        )}
      </button>
      <figcaption
        className={clsx(
          'flex items-center gap-2 px-2 py-1 text-[10px]',
          mine ? 'text-brand-50' : 'text-slate-600',
        )}
      >
        <span className="flex-1 truncate">{attachment.filename || '(encrypted image)'}</span>
        {/* JPEG + PNG get a secondary "PDF" action. Same decrypt path, we
            just wrap the bytes in a one-page PDF before handing them to the
            browser. Gated to image/jpeg|image/png by isPdfConvertible, which
            matches what pdf-lib can embed natively. */}
        {isPdfConvertibleInline(attachment.mimeType) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDownloadAsPdf();
            }}
            className={clsx(
              'rounded px-1.5 py-0.5 text-[10px] font-semibold hover:underline',
              mine ? 'bg-brand-500/30 hover:bg-brand-500/60' : 'bg-slate-200 hover:bg-slate-300',
            )}
            title="Download this image as a PDF"
          >
            PDF
          </button>
        )}
        <span className="opacity-70">{humanSize(attachment.sizeBytes)}</span>
      </figcaption>
    </figure>
  );
}

function AttachmentChip({
  attachment,
  mine,
  onDownload,
}: {
  attachment: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    scanStatus: 'pending' | 'clean' | 'infected';
  };
  mine: boolean;
  onDownload: () => void;
}): JSX.Element {
  const infected = attachment.scanStatus === 'infected';
  const pending = attachment.scanStatus === 'pending';
  return (
    <button
      type="button"
      onClick={infected ? undefined : onDownload}
      disabled={infected || pending}
      className={clsx(
        'flex items-center gap-2 text-xs rounded-md px-2 py-1 w-full text-left',
        mine ? 'bg-brand-500/40 hover:bg-brand-500/60 text-brand-50' : 'bg-slate-100 hover:bg-slate-200 text-slate-700',
        infected && 'bg-rose-100 text-rose-800 cursor-not-allowed',
        pending && 'opacity-60 cursor-progress',
      )}
      title={infected ? 'Blocked by virus scan' : pending ? 'Scan pending' : 'Download'}
    >
      <span aria-hidden>{infected ? '⚠' : '📎'}</span>
      <span className="flex-1 truncate">{attachment.filename || '(encrypted file)'}</span>
      <span className="text-[10px] opacity-70">{humanSize(attachment.sizeBytes)}</span>
    </button>
  );
}

/**
 * Wrap a libsodium-produced Uint8Array into a Blob. libsodium's outputs are
 * typed as Uint8Array<ArrayBufferLike> which includes SharedArrayBuffer —
 * the structural type that Blob's constructor rejects. Copy into a fresh
 * ArrayBuffer so TypeScript (and worker/shared-array-buffer-free contexts)
 * are both happy.
 */
function bytesToBlob(bytes: Uint8Array, mimeType: string): Blob {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy], { type: mimeType });
}

/** Sum-of-sizes cap for the per-message "save all as PDF" flow. Past this
 *  we refuse the combine rather than hang the tab decrypting + embedding
 *  hundreds of MB of JPEGs. Users can still save each image individually. */
const COMBINED_PDF_SIZE_CAP = 50 * 1024 * 1024;

/** Synchronous MIME gate for the PDF button. Duplicates the check in
 *  apps/web/src/lib/imageToPdf.ts::isPdfConvertible so the render path
 *  doesn't have to await a dynamic-import before deciding whether to show
 *  the button at all — pdf-lib stays lazy-loaded only when a user clicks. */
function isPdfConvertibleInline(mimeType: string): boolean {
  return mimeType === 'image/jpeg' || mimeType === 'image/jpg' || mimeType === 'image/png';
}

/** Swap an image filename's extension for `.pdf`, preserving the stem so a
 *  `receipt-2024.jpg` attachment saves as `receipt-2024.pdf`. Empty or
 *  nameless input falls back to a generic stem. */
function pdfFilenameForImage(filename: string | null | undefined): string {
  const name = (filename ?? '').trim();
  if (!name) return 'image.pdf';
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.pdf`;
}

/** Synthesize a browser download from a Blob. Shared between the original-
 *  format download and the new PDF download so there's one place to audit
 *  the anchor-click-and-revoke pattern. */
function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Compose({
  body,
  urgent,
  scheduledFor,
  pendingFile,
  uploadState,
  uploadDetail,
  mentionCandidates,
  disabled,
  disabledReason,
  onBody,
  onUrgent,
  onScheduledFor,
  onPickFile,
  onSend,
}: {
  body: string;
  urgent: boolean;
  scheduledFor: string | null;
  pendingFile: File | null;
  uploadState:
    | 'idle'
    | 'encrypting'
    | 'uploading'
    | 'done'
    | 'infected'
    | 'blocked'
    | 'scanUnavailable';
  uploadDetail: string | null;
  mentionCandidates: PublicUser[];
  disabled?: boolean;
  disabledReason?: string | null;
  onBody: (v: string) => void;
  onUrgent: (v: boolean) => void;
  onScheduledFor: (v: string | null) => void;
  onPickFile: (f: File | null) => void;
  onSend: () => void;
}): JSX.Element {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Compute mention prefix from the text preceding the cursor (or end of body).
  // Matches `@word` where `word` has only name-safe characters and starts on a
  // word boundary.
  const mentionState = useMemo(() => {
    const caret = textareaRef.current?.selectionStart ?? body.length;
    const before = body.slice(0, caret);
    const match = /(?:^|\s)@([A-Za-z0-9._-]*)$/.exec(before);
    if (!match) return null;
    const prefix = match[1]!.toLowerCase();
    const matches = mentionCandidates
      .filter(
        (u) =>
          u.displayName.toLowerCase().includes(prefix) ||
          u.username.toLowerCase().includes(prefix),
      )
      .slice(0, 6);
    if (matches.length === 0) return null;
    return { prefix, startIndex: caret - match[0].length + match[0].indexOf('@'), matches };
  }, [body, mentionCandidates]);
  const [mentionIdx, setMentionIdx] = useState(0);

  function pickMention(user: PublicUser): void {
    if (!mentionState) return;
    const before = body.slice(0, mentionState.startIndex);
    const caret = textareaRef.current?.selectionStart ?? body.length;
    const after = body.slice(caret);
    const inserted = `@${user.displayName.replace(/\s+/g, '')} `;
    onBody(before + inserted + after);
    // Best-effort: refocus the textarea so typing continues naturally.
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      const pos = before.length + inserted.length;
      t.setSelectionRange(pos, pos);
    });
  }
  return (
    <div className="border-t border-slate-200 bg-white p-3 relative">
      {mentionState && (
        <div className="absolute -top-1 left-3 right-3 transform -translate-y-full bg-white border border-slate-200 rounded-md shadow-popover z-20">
          <div className="text-[10px] uppercase tracking-wide text-slate-400 px-2 pt-1">
            Mention
          </div>
          {mentionState.matches.map((u, i) => (
            <button
              key={u.id}
              type="button"
              onClick={() => pickMention(u)}
              className={clsx(
                'w-full text-left px-2 py-1.5 text-sm flex items-center gap-2',
                i === mentionIdx ? 'bg-brand-50' : 'hover:bg-slate-50',
              )}
            >
              <span className="w-5 h-5 rounded-full bg-slate-200 grid place-items-center text-[10px] font-medium text-slate-700">
                {u.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="font-medium">{u.displayName}</span>
              <span className="text-xs text-slate-500">@{u.username}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-start gap-2">
        <textarea
          ref={textareaRef}
          rows={2}
          className="flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          placeholder="Type a message. **bold**, _italic_, shift+enter for newline. @ to mention."
          value={body}
          onChange={(e) => {
            onBody(e.target.value);
            setMentionIdx(0);
          }}
          onKeyDown={(e) => {
            if (mentionState) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionIdx((i) => (i + 1) % mentionState.matches.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionIdx(
                  (i) => (i - 1 + mentionState.matches.length) % mentionState.matches.length,
                );
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pickMention(mentionState.matches[mentionIdx]!);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                // Append a space so the regex stops matching without destroying the user's text.
                onBody(body + ' ');
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <div className="flex flex-col gap-1 items-stretch">
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={urgent}
              onChange={(e) => onUrgent(e.target.checked)}
              className="accent-rose-500"
            />
            Urgent
          </label>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.gif,.docx,.xlsx,.pptx,.doc,.xls,.ppt,.zip,.csv,.txt"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              onPickFile(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            title="Attach file"
            className="rounded-md border border-slate-300 text-slate-600 text-sm px-3 py-1 hover:bg-slate-50"
          >
            📎 Attach
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || (!body.trim() && !pendingFile)}
            title={disabled && disabledReason ? disabledReason : undefined}
            className="rounded-md bg-brand-600 text-white font-medium px-4 py-2 text-sm hover:bg-brand-700 disabled:opacity-60"
          >
            {scheduledFor ? 'Schedule' : 'Send'}
          </button>
        </div>
      </div>
      {pendingFile && uploadState === 'idle' && (
        <div className="mt-2 text-xs text-slate-600 flex items-center gap-2">
          <span>📎</span>
          <span className="truncate flex-1">{pendingFile.name}</span>
          <span className="text-slate-400">{humanSize(pendingFile.size)}</span>
          <button
            type="button"
            onClick={() => onPickFile(null)}
            className="text-slate-500 hover:text-slate-800"
            aria-label="Remove attachment"
          >
            ×
          </button>
        </div>
      )}
      {uploadState !== 'idle' && (
        <div
          className={clsx(
            'mt-2 text-xs px-2 py-1 rounded border',
            uploadState === 'infected'
              ? 'bg-rose-50 text-rose-800 border-rose-200'
              : uploadState === 'blocked' || uploadState === 'scanUnavailable'
                ? 'bg-amber-50 text-amber-900 border-amber-200'
                : uploadState === 'done'
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : 'bg-slate-50 text-slate-600 border-slate-200',
          )}
        >
          {uploadState === 'encrypting' && 'Encrypting attachment…'}
          {uploadState === 'uploading' && 'Uploading…'}
          {uploadState === 'done' && 'Attachment delivered ✓'}
          {uploadState === 'blocked' && (uploadDetail ?? 'Upload failed.')}
          {uploadState === 'scanUnavailable' &&
            'Virus scanner is temporarily unavailable. Please retry in a moment.'}
          {uploadState === 'infected' && (
            <>
              Rejected: virus scan flagged this file.
              {uploadDetail && <span className="ml-1 text-rose-600">({uploadDetail})</span>}
            </>
          )}
        </div>
      )}
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
): { title: string; subtitle: string; presence: PublicUser['status'] | 'mixed' | null } {
  if (!conv) return { title: 'Conversation', subtitle: '', presence: null };
  const otherIds = conv.members
    .map((m) => m.userId)
    .filter((u): u is string => Boolean(u) && u !== me);
  const otherUsers = otherIds.map((id) => users[id]).filter((u): u is PublicUser => Boolean(u));
  // Pick a single status dot for the header: 'active' if anyone is active, else worst status.
  let presence: PublicUser['status'] | 'mixed' | null = null;
  if (otherUsers.length === 1) presence = otherUsers[0]!.status;
  else if (otherUsers.length > 1) {
    if (otherUsers.some((u) => u.status === 'active')) presence = 'active';
    else if (otherUsers.some((u) => u.status === 'dnd')) presence = 'dnd';
    else if (otherUsers.some((u) => u.status === 'away')) presence = 'away';
    else presence = 'offline';
  }
  if (conv.displayName) return { title: conv.displayName, subtitle: conv.type, presence };
  const names = otherUsers.map((u) => u.displayName);
  return { title: names.join(', ') || 'Conversation', subtitle: conv.type, presence };
}

function PresenceDot({ status }: { status: PublicUser['status'] | 'mixed' | null }): JSX.Element | null {
  if (!status) return null;
  const color =
    status === 'active'
      ? 'bg-emerald-500'
      : status === 'away'
        ? 'bg-amber-400'
        : status === 'dnd'
          ? 'bg-rose-500'
          : 'bg-slate-300';
  const label =
    status === 'active'
      ? 'Online'
      : status === 'away'
        ? 'Away'
        : status === 'dnd'
          ? 'Do not disturb'
          : 'Offline';
  return (
    <span className="flex items-center gap-1 text-xs text-slate-500" title={label}>
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} aria-hidden />
      {label}
    </span>
  );
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
