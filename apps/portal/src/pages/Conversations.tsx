import { useEffect, useMemo, useRef, useState } from 'react';
// Type-only — keeps libsodium (~986 KB) out of the first-paint bundle for /login and /verify.
import type * as CryptoModule from '@vibe-connect/crypto';
import { portalApi } from '../api.js';
import { getSessionKeys } from '../state/clientSession.js';
import { url as buildUrl } from '../lib/boot.js';
import { RequestsPanel, type PickedItem } from './RequestsPanel.js';

let cryptoPromise: Promise<typeof CryptoModule> | null = null;
async function loadCrypto(): Promise<typeof CryptoModule> {
  if (!cryptoPromise) cryptoPromise = import('@vibe-connect/crypto');
  const c = await cryptoPromise;
  await c.ready();
  return c;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  // Distribution mode: prepend BASE_PATH so multi-app deploys hit
  // /connect/portal/... instead of /portal/... (which would land on a
  // sibling Vibe app under the same Caddy ingress).
  const r = await fetch(buildUrl(path), {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw Object.assign(new Error(`${r.status}`), { status: r.status });
  return (await r.json()) as T;
}

interface ConversationSummary {
  id: string;
  displayName: string | null;
  updatedAt: string;
  // Optional hints from the server — used to surface "last activity N minutes
  // ago" chips in the sidebar without a per-conversation round trip. Safe to
  // ignore on older server versions that don't return them.
  lastMessageAt?: string | null;
  lastMessageSource?: 'app' | 'email-in' | 'sms-in' | 'system' | null;
}

interface ConvDetail {
  id: string;
  displayName: string | null;
  stepupRequired: boolean;
  rotationVersion: number | null;
  wrappedKeys: Record<string, string> | null;
}

interface MsgAttachment {
  id: string;
  messageId: string;
  filenameCiphertext: string;
  mimeType: string;
  sizeBytes: number;
  wrappedFileKey: string;
  scanStatus: 'pending' | 'clean' | 'infected';
  createdAt: string;
}

interface Msg {
  id: string;
  senderId: string | null;
  senderExternalIdentityId: string | null;
  ciphertext: string;
  contentKeyVersion: number;
  urgent: boolean;
  source: 'app' | 'email-in' | 'sms-in' | 'system';
  createdAt: string;
  editedAt: string | null;
  /** Phase 27: present when staff has soft-deleted this message. The portal
   *  renders a "Message deleted" placeholder; the row stays in the list so
   *  the timeline doesn't visually collapse where the message used to be. */
  deletedAt?: string | null;
  /** Cleartext metadata; for `source='system'` carries `systemEventType` and
   *  Phase 24 nudge/revision payloads we render directly without decrypt. */
  ciphertextMeta?: Record<string, unknown> | null;
  attachments?: MsgAttachment[];
}

/**
 * Phase 24 follow-up: render system messages from their cleartext
 * `ciphertext_meta` instead of trying to decrypt the empty ciphertext.
 * Mirrors the matching branch in apps/web/src/state/crypto.tsx.
 */
function renderSystemMessageBody(m: Msg): string {
  const meta = (m.ciphertextMeta ?? {}) as Record<string, unknown>;
  const eventType = String(meta.systemEventType ?? '');
  if (eventType === 'request_item_revision') {
    return '🔁 Your firm asked for a revision. See the Requests panel for the note.';
  }
  if (eventType === 'request_nudge_sent') {
    const listTitle = typeof meta.listTitle === 'string' ? meta.listTitle : 'pending items';
    const custom = typeof meta.customBody === 'string' ? meta.customBody : null;
    return custom ? `🔔 Reminder: ${custom}` : `🔔 Reminder — items still needed for ${listTitle}.`;
  }
  if (eventType === 'request_item_done') return '✅ Item marked done.';
  if (eventType === 'request_list_created') return '📝 New request list created.';
  return '⚙ System event';
}

/** Files above this size render as a download chip even when image/*. See
 *  the matching cap in apps/web/src/components/ConversationView.tsx. */
const PORTAL_INLINE_IMAGE_SIZE_CAP = 10 * 1024 * 1024;

/** Sum-of-sizes cap for the combine-to-PDF flow. Past this we refuse. */
const PORTAL_COMBINED_PDF_SIZE_CAP = 50 * 1024 * 1024;

/** Synchronous gate for the PDF button — render-time MIME check so pdf-lib
 *  stays lazy-loaded. Mirrors isPdfConvertible in ../lib/imageToPdf.ts. */
function isPdfConvertibleInline(mimeType: string): boolean {
  return mimeType === 'image/jpeg' || mimeType === 'image/jpg' || mimeType === 'image/png';
}

/** Synthesize a browser download from a Blob. */
function portalTriggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** libsodium outputs are typed as Uint8Array<ArrayBufferLike> which Blob's
 *  constructor rejects. Copy into a fresh ArrayBuffer. */
function bytesToBlob(bytes: Uint8Array, mimeType: string): Blob {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy], { type: mimeType });
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Compact relative-time formatter for sidebar cards. Falls back to a short
 * absolute date once the delta is over a week so a glance can tell "active"
 * threads from dormant ones. Intl.RelativeTimeFormat produces the
 * locale-aware string ("2 hours ago"); we bucket the delta manually so we
 * choose the right unit.
 */
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  // Clamp negative deltas (clock skew / stale system clock) to zero so the UI
  // never displays "-3 mins ago". Browsers and servers stay loosely in sync
  // via HTTP Date headers; a sub-second skew here produces "just now" which
  // is correct enough.
  const deltaMs = Math.max(0, Date.now() - t);
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

export function ConversationsPage(): JSX.Element {
  const [me, setMe] = useState<{
    identityId: string;
    displayName: string;
    verifiedUntil: string | null;
  } | null>(null);
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Tick counter bumps every 60s so `formatRelative` labels rerender in
  // place. Without this, a user who keeps the sidebar open without
  // interacting would see "5 min ago" stay "5 min ago" until something else
  // triggered a render. The counter value itself isn't rendered — reading
  // it in the map() below is enough to register the dependency.
  const [relativeTick, setRelativeTick] = useState(0);
  useEffect(() => {
    const handle = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        setRelativeTick((n) => n + 1);
      }
    }, 60_000);
    return () => window.clearInterval(handle);
  }, []);

  useEffect(() => {
    portalApi
      .me()
      .then((r) => {
        // Identity unauthenticated → bounce back to start. Without this, the
        // page silently shows "No conversations yet" when the session cookie
        // is invalid or expired, hiding the real cause from the user.
        if (!r.identity) {
          window.location.href = buildUrl('/');
          return;
        }
        setMe({
          identityId: r.identity.id,
          displayName: r.identity.displayName,
          verifiedUntil: r.session.verifiedUntil,
        });
      })
      .catch(() => {
        window.location.href = buildUrl('/');
      });
    json<{ conversations: ConversationSummary[] }>('/portal/conversations').then((r) =>
      setConvs(r.conversations),
    );
  }, []);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-brand-600 text-white grid place-items-center font-bold text-sm">
            VC
          </div>
          <span className="font-semibold">Messages from your firm</span>
        </div>
        <div className="text-sm text-slate-600">
          {me?.displayName} ·{' '}
          <button
            type="button"
            onClick={() => portalApi.logout().then(() => (window.location.href = buildUrl('/')))}
            className="text-brand-700 hover:underline"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="max-w-2xl mx-auto p-4 space-y-3">
        <PendingRequestsBanner onOpen={(convId) => setActiveId(convId)} />
        {/* relativeTick is read here so the render depends on it; a bare read
            in the map() below would also work but keeping the acknowledgement
            up-front makes the intent obvious. */}
        <ul
          className="bg-white rounded shadow divide-y divide-slate-100"
          data-rel-tick={relativeTick}
        >
          {convs.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setActiveId(c.id)}
                className={`w-full text-left px-4 py-3 hover:bg-slate-50 ${
                  activeId === c.id ? 'bg-brand-50' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium flex-1 truncate">
                    {c.displayName ?? '(conversation)'}
                  </span>
                  {c.lastMessageSource &&
                    c.lastMessageSource !== 'app' &&
                    c.lastMessageSource !== 'system' && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-900 px-2 py-0.5 text-[10px] font-semibold"
                        title={`Latest reply arrived via ${c.lastMessageSource === 'email-in' ? 'email' : 'SMS'}`}
                      >
                        <span aria-hidden="true">
                          {c.lastMessageSource === 'email-in' ? '✉' : '💬'}
                        </span>
                        {c.lastMessageSource === 'email-in' ? 'email' : 'SMS'}
                      </span>
                    )}
                </div>
                <div className="text-xs text-slate-500">
                  {formatRelative(c.lastMessageAt ?? c.updatedAt)}
                </div>
              </button>
            </li>
          ))}
          {convs.length === 0 && (
            <li className="px-4 py-6 text-sm text-slate-500 text-center">No conversations yet.</li>
          )}
        </ul>
        {activeId && me && <ActiveConversation id={activeId} myIdentityId={me.identityId} />}
      </main>
    </div>
  );
}

/**
 * Phase 24.8 — portal home banner. Counts open items (pending + revision)
 * across every active list the client is a member of, and surfaces them
 * above the conversation list. Tapping the banner jumps into the first
 * conversation that has open items so the client lands one click away
 * from responding.
 *
 * Item titles + descriptions are E2EE; the banner renders only counts +
 * the cleartext list title, no item details. We don't decrypt items here
 * — that happens inside the Requests panel after the conversation key is
 * unwrapped.
 */
function PendingRequestsBanner({
  onOpen,
}: {
  onOpen: (conversationId: string) => void;
}): JSX.Element | null {
  const [counts, setCounts] = useState<{
    pending: number;
    revision: number;
    firstConvId: string | null;
    firstListTitle: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const summary = await portalApi.requests.list();
        if (cancelled) return;
        // Walk each active list once to get item counts. The portal endpoint
        // returns metadata only — counts come from the per-list /get call.
        let pending = 0;
        let revision = 0;
        let firstConvId: string | null = null;
        let firstListTitle: string | null = null;
        for (const l of summary.lists) {
          const detail = await portalApi.requests.get(l.id);
          if (cancelled) return;
          for (const item of detail.list.items) {
            if (item.status === 'pending') pending++;
            else if (item.status === 'revision') revision++;
          }
          if (!firstConvId && (pending > 0 || revision > 0)) {
            firstConvId = l.conversationId;
            firstListTitle = l.title;
          }
        }
        setCounts({ pending, revision, firstConvId, firstListTitle });
      } catch {
        // Silent — server might be down or not yet seeded; no banner is fine.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!counts || (counts.pending === 0 && counts.revision === 0)) return null;
  const total = counts.pending + counts.revision;
  return (
    <button
      type="button"
      onClick={() => counts.firstConvId && onOpen(counts.firstConvId)}
      className="w-full text-left rounded border border-brand-200 bg-brand-50 px-4 py-3 hover:bg-brand-100"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-brand-900">
            You have {total} item{total === 1 ? '' : 's'} to respond to
          </div>
          {counts.firstListTitle && (
            <div className="text-xs text-brand-800 mt-0.5">
              Starting with <strong>{counts.firstListTitle}</strong>
              {counts.revision > 0 && (
                <span className="ml-1 text-rose-700">
                  · {counts.revision} need
                  {counts.revision === 1 ? 's' : ''} another look
                </span>
              )}
            </div>
          )}
        </div>
        <span className="text-xs text-brand-700 font-medium whitespace-nowrap">Open →</span>
      </div>
    </button>
  );
}

function ActiveConversation({
  id,
  myIdentityId,
}: {
  id: string;
  myIdentityId: string;
}): JSX.Element {
  const [detail, setDetail] = useState<ConvDetail | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [convKey, setConvKey] = useState<Uint8Array | null>(null);
  const [decryptedBodies, setDecryptedBodies] = useState<Record<string, string>>({});
  const [body, setBody] = useState('');
  // Track the files the user has staged but hasn't sent yet — see sendMessage
  // for the "send message then attach" ordering that relies on this. Phase
  // 24.5 expanded this from a single file to a small array so a client can
  // attach a stack of receipts in one submission.
  // Each staged file gets a stable id at staging time so React's chip list
  // reconciles correctly across removes. Using array index as the key would
  // unmount/remount the wrong chips when an earlier one is removed.
  interface StagedFile {
    id: string;
    file: File;
  }
  const [pendingFiles, setPendingFiles] = useState<StagedFile[]>([]);
  const PORTAL_MAX_ATTACHMENTS = 10;
  const stageFile = (f: File): StagedFile => ({
    id:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    file: f,
  });
  // Inline error for the "combine images as PDF" flow. Replaces a window.alert
  // call that jarred the portal out of its polished style.
  const [combineError, setCombineError] = useState<string | null>(null);
  // Phase 24 follow-up: distinct send-error surface so a failed message POST
  // (rate-limit, validation, server 5xx) doesn't get conflated with the
  // combine-PDF error chip. The dismiss action on send errors should be
  // semantically "ack and retry" not "abandon"; we keep the linked-item pin
  // so the retry preserves the user's intent.
  const [sendError, setSendError] = useState<string | null>(null);
  const [uploadState, setUploadState] = useState<
    | 'idle'
    | 'encrypting'
    | 'uploading'
    | 'scanning'
    | 'done'
    | 'blocked'
    | 'infected'
    | 'scanUnavailable'
  >('idle');
  const [uploadDetail, setUploadDetail] = useState<string | null>(null);
  const session = useMemo(() => getSessionKeys(), []);
  // Phase 24: Requests panel state. `linkedItem` pins the next outbound
  // message to a specific request item — the staff side then sees the
  // submission auto-flip the item's status to "submitted".
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [linkedItem, setLinkedItem] = useState<PickedItem | null>(null);
  // Phase 24 kill switch: hide the Requests pill + block opening the panel
  // when the firm has turned the feature off. The portal has no security-
  // policy endpoint, so we infer the toggle from the same /portal/request-
  // lists payload the banner already calls (it returns requestsDisabled:true
  // and an empty list when the feature is off).
  const [requestsDisabled, setRequestsDisabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void portalApi.requests
      .list()
      .then((r) => {
        if (!cancelled) setRequestsDisabled(r.requestsDisabled === true);
      })
      .catch(() => {
        // Network failure leaves the pill visible — opening it will surface
        // the error properly inside the panel.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setDetail(null);
    setMessages([]);
    setConvKey(null);
    setDecryptedBodies({});
    json<ConvDetail>(`/portal/conversations/${id}`).then(setDetail);
    json<{ messages: Msg[] }>(`/portal/conversations/${id}/messages`).then((r) =>
      setMessages(r.messages),
    );
  }, [id]);

  // Poll for new messages every 15s while this conversation is active.
  // Portal clients don't have a Socket.io channel (server side doesn't yet
  // authenticate portal sessions to socket.io), so without polling the user
  // never sees staff replies until they reload the page. Only poll while the
  // tab is visible so idle portal tabs don't thrash the server.
  useEffect(() => {
    let stopped = false;
    const POLL_MS = 15_000;
    async function poll(): Promise<void> {
      if (stopped) return;
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await json<{ messages: Msg[] }>(`/portal/conversations/${id}/messages`);
        if (stopped) return;
        setMessages(r.messages);
      } catch {
        /* transient 401/network; next tick retries */
      }
    }
    const handle = window.setInterval(() => void poll(), POLL_MS);
    const onVis = (): void => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      window.clearInterval(handle);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [id]);

  useEffect(() => {
    if (!detail || !session || !detail.wrappedKeys) return;
    (async () => {
      const crypto = await loadCrypto();
      // Find our session's wrapped slot. We don't yet know this session's
      // id without an extra round-trip, so we try every entry until the
      // unwrap succeeds. Production note: /portal/me should return the
      // session id so we can key in directly; tracked separately.
      for (const [, wrapped] of Object.entries(detail.wrappedKeys!)) {
        try {
          const k = await crypto.unwrapKey(wrapped, session.publicKey, session.secretKey);
          setConvKey(k);
          break;
        } catch {
          /* try next */
        }
      }
    })();
  }, [detail, session]);

  // Phase 27: mark every staff-sent message read once it surfaces in the
  // portal. This is what arms the destruct timer server-side; without it,
  // self-destruct messages would never start their countdown for client
  // recipients. Local memo prevents re-marking on every poll tick.
  const markedReadRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (messages.length === 0) return;
    for (const m of messages) {
      if (m.deletedAt) continue;
      if (m.senderExternalIdentityId === myIdentityId) continue;
      if (markedReadRef.current.has(m.id)) continue;
      markedReadRef.current.add(m.id);
      // Best-effort POST. The server idempotently no-ops a duplicate read,
      // and a network failure just means the next poll will retry once we
      // clear the memo if needed (we don't here; the next session will).
      void fetch(buildUrl(`/portal/conversations/messages/${m.id}/read`), {
        method: 'POST',
        credentials: 'include',
      }).catch(() => undefined);
    }
  }, [messages, myIdentityId]);

  useEffect(() => {
    if (!convKey || messages.length === 0) return;
    let cancelled = false;
    (async () => {
      const crypto = await loadCrypto();
      // Memoise: only decrypt messages whose id we haven't seen before. A
      // 15-second poll that replaces the list would otherwise re-run XChaCha
      // for every message on every tick — for a 100-message conversation
      // that's ~400 decrypts per minute per open tab.
      setDecryptedBodies((prev) => {
        const out = { ...prev };
        for (const m of messages) {
          if (out[m.id]) continue;
          // Phase 27: deleted rows arrive with empty ciphertext. Render the
          // tombstone placeholder directly without trying to decrypt.
          if (m.deletedAt) {
            out[m.id] = '__deleted__';
            continue;
          }
          // Bridged-in messages (email-in, sms-in) are sealed to the firm
          // public key, not the conversation key. Staff sees a placeholder
          // until the first rewrap pass; the portal should do the same
          // instead of trying a secretbox decrypt that's guaranteed to fail.
          if (m.contentKeyVersion === 0 && (m.source === 'email-in' || m.source === 'sms-in')) {
            out[m.id] =
              m.source === 'email-in'
                ? '[bridged email — preview unavailable until staff opens it]'
                : '[bridged SMS — preview unavailable until staff opens it]';
            continue;
          }
          // Phase 24: system messages render directly from cleartext meta;
          // skip the `__decrypting__` placeholder for them.
          if (m.source === 'system') {
            out[m.id] = renderSystemMessageBody(m);
            continue;
          }
          out[m.id] = '__decrypting__';
        }
        return out;
      });
      for (const m of messages) {
        if (cancelled) return;
        // Skip messages already decrypted or marked bridge-pending.
        // decryptedBodies state isn't read here directly (stale closure), so
        // we re-check by attempting parse/decrypt and catching.
        if (m.deletedAt) continue;
        if (m.contentKeyVersion === 0 && (m.source === 'email-in' || m.source === 'sms-in')) {
          continue;
        }
        // Phase 24: system messages have empty ciphertext; render from meta.
        if (m.source === 'system') {
          setDecryptedBodies((prev) => ({ ...prev, [m.id]: renderSystemMessageBody(m) }));
          continue;
        }
        try {
          const env = JSON.parse(atob(m.ciphertext)) as CryptoModule.SymmetricEnvelope;
          const plain = await crypto.decryptMessage(env, convKey);
          if (cancelled) return;
          const body = crypto.utf8Decode(plain);
          setDecryptedBodies((prev) => ({ ...prev, [m.id]: body }));
        } catch {
          if (cancelled) return;
          setDecryptedBodies((prev) => ({ ...prev, [m.id]: '(unable to decrypt)' }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [convKey, messages]);

  /**
   * Fetch + decrypt an attachment to plaintext bytes. Re-usable by both the
   * download-to-disk path and the inline image preview.
   */
  async function decryptAttachmentBytes(att: MsgAttachment): Promise<Uint8Array | null> {
    if (!convKey) return null;
    const crypto = await loadCrypto();
    // File key was wrapped to the CONVERSATION key (secretbox), same as on
    // the staff side. We already have convKey from the wrapped-keys unwrap.
    const fileKey = await crypto.secretboxDecrypt(att.wrappedFileKey, convKey);
    const res = await fetch(`/portal/conversations/attachments/${att.id}`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    const cipherBuf = await res.arrayBuffer();
    const envelope = JSON.parse(
      crypto.utf8Decode(new Uint8Array(cipherBuf)),
    ) as CryptoModule.SymmetricEnvelope;
    const plain = await crypto.decryptMessage(envelope, fileKey);
    // Copy into an ArrayBuffer-backed Uint8Array so downstream Blob()
    // construction doesn't trip on SharedArrayBuffer-backed views.
    const plainCopy = new Uint8Array(plain.byteLength);
    plainCopy.set(plain);
    return plainCopy;
  }

  async function downloadAttachment(att: MsgAttachment): Promise<void> {
    const bytes = await decryptAttachmentBytes(att);
    if (!bytes) return;
    // We don't know the plaintext filename on the client without another
    // secretbox decrypt; the portal's upload path only stores the filename
    // ciphertext on the server. Fall back to att.id as the download name —
    // the MIME-typed Blob still saves with the right extension in most
    // browsers. (Staff UI has access to the decrypted filename.)
    portalTriggerDownload(bytesToBlob(bytes, att.mimeType), `${att.id}.bin`);
  }

  /** Per-image PDF download. Decrypt once, wrap in a one-page PDF. */
  async function downloadImageAsPdf(att: MsgAttachment): Promise<void> {
    const bytes = await decryptAttachmentBytes(att);
    if (!bytes) return;
    const { imagesToPdf } = await import('../lib/imageToPdf.js');
    const pdfBytes = await imagesToPdf([{ bytes, mimeType: att.mimeType }]);
    portalTriggerDownload(
      bytesToBlob(pdfBytes, 'application/pdf'),
      `image-${att.id.slice(0, 8)}.pdf`,
    );
  }

  /**
   * Combine every eligible image on a message into one PDF. Sequential
   * decrypt — same reasoning as the staff web: the per-IP rate limiter
   * would trip on a parallel burst, and peak memory stays bounded at one
   * image-worth of plaintext plus the accumulating PDF buffer.
   */
  async function downloadMessageImagesAsPdf(msg: Msg): Promise<void> {
    const { isPdfConvertible, imagesToPdf } = await import('../lib/imageToPdf.js');
    const eligible = (msg.attachments ?? []).filter(
      (a) =>
        a.scanStatus === 'clean' &&
        isPdfConvertible(a.mimeType) &&
        a.sizeBytes <= PORTAL_INLINE_IMAGE_SIZE_CAP,
    );
    if (eligible.length === 0) return;
    const totalBytes = eligible.reduce((sum, a) => sum + a.sizeBytes, 0);
    if (totalBytes > PORTAL_COMBINED_PDF_SIZE_CAP) {
      setCombineError(
        `Combined PDF would be ~${Math.round(totalBytes / 1024 / 1024)} MB. Save images individually instead.`,
      );
      return;
    }
    setCombineError(null);
    const images: Array<{ bytes: Uint8Array; mimeType: string }> = [];
    for (const att of eligible) {
      try {
        const bytes = await decryptAttachmentBytes(att);
        if (bytes) images.push({ bytes, mimeType: att.mimeType });
      } catch {
        // Skip unreadable; a partial PDF is still useful.
      }
    }
    if (images.length === 0) return;
    const pdfBytes = await imagesToPdf(images);
    const datePart = new Date(msg.createdAt).toISOString().slice(0, 10);
    portalTriggerDownload(bytesToBlob(pdfBytes, 'application/pdf'), `attachments-${datePart}.pdf`);
  }

  /**
   * Send `body` (and optionally a pending file) as one logical message.
   *
   * Order matters: we must POST the message FIRST so we have a real
   * server-generated message id, then attach the file to that id. The
   * pre-fix code attached files to `messages.at(-1)?.id`, which routed
   * the upload to the previous message (often someone else's) and broke
   * authorisation. If only a file is queued and `body` is empty, we
   * send a one-character marker so the message row exists.
   */
  async function sendMessage(): Promise<{ id: string } | null> {
    if (!convKey || !detail) return null;
    const trimmed = body.trim();
    if (!trimmed && pendingFiles.length === 0) return null;
    const crypto = await loadCrypto();
    const messageBody =
      trimmed ||
      (pendingFiles.length > 0
        ? `(attachment${pendingFiles.length > 1 ? 's' : ''}: ${pendingFiles
            .map((f) => f.file.name)
            .join(', ')})`
        : '');
    const env = await crypto.encryptMessage(
      crypto.utf8Encode(messageBody),
      convKey,
      detail.rotationVersion ?? 1,
    );
    const ciphertext = btoa(JSON.stringify(env));
    // Phase 24: pin the message to a request item when one is selected. The
    // server-side post-insert hook reads `ciphertextMeta.requestItemId` and
    // auto-flips the item to `submitted` once the response_type rule is met
    // (text content, attachment, or both). The pin clears after this send so
    // a follow-up unrelated message doesn't accidentally re-link.
    const ciphertextMeta = linkedItem ? { requestItemId: linkedItem.itemId } : undefined;
    const res = await fetch(`/portal/conversations/${id}/messages`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ciphertext,
        contentKeyVersion: detail.rotationVersion ?? 1,
        ...(ciphertextMeta ? { ciphertextMeta } : {}),
      }),
    });
    setBody('');
    if (!res.ok) {
      // Phase 24 follow-up: surface failed sends so the user knows their
      // pinned item didn't actually go through. Pre-fix the empty composer
      // looked like success while linkedItem stayed pinned, confusing
      // downstream sends. Keep linkedItem so a retry preserves the pin.
      let errMsg = `Send failed (${res.status})`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error === 'rate_limited') errMsg = 'Rate limit hit. Please wait and retry.';
        else if (body.error) errMsg = `Send failed: ${body.error}`;
      } catch {
        /* non-JSON response */
      }
      setSendError(errMsg);
      return null;
    }
    const created = (await res.json()) as { id: string };
    if (pendingFiles.length > 0) {
      // Sequential upload — peak memory stays bounded at one file's worth of
      // plaintext, and the per-IP rate limiter doesn't trip on a parallel
      // burst of N attachments. uploadFile returns the final state for THIS
      // file so we can break on infected/scan-unavailable without relying
      // on the React state ref (which is closure-captured and stale).
      try {
        for (const staged of pendingFiles) {
          const outcome = await uploadFile(staged.file, created.id);
          if (outcome === 'infected' || outcome === 'scanUnavailable') break;
        }
      } finally {
        setPendingFiles([]);
      }
    }
    setLinkedItem(null);
    const reload = await json<{ messages: Msg[] }>(`/portal/conversations/${id}/messages`);
    setMessages(reload.messages);
    return created;
  }

  async function uploadFile(
    file: File,
    messageId: string,
  ): Promise<'done' | 'infected' | 'scanUnavailable' | 'blocked'> {
    if (!convKey) return 'blocked';
    setUploadState('encrypting');
    const crypto = await loadCrypto();
    const fileKey = await crypto.generateSymmetricKey();
    const env = await crypto.encryptMessage(new Uint8Array(await file.arrayBuffer()), fileKey, 1);
    // File key is wrapped to the CONVERSATION key (symmetric secretbox), not to
    // the portal session's asymmetric public key. Staff code downloads and
    // calls `secretboxDecrypt(wrappedFileKey, convKey)` — they can only reach
    // the file if both sides use the same wrapping. Filename is encrypted the
    // same way so the download UI can render a meaningful name.
    const wrappedFileKey = await crypto.secretboxEncrypt(fileKey, convKey);
    const filenameCiphertext = await crypto.secretboxEncrypt(crypto.utf8Encode(file.name), convKey);
    setUploadState('uploading');
    const form = new FormData();
    form.set('file', new Blob([JSON.stringify(env)], { type: file.type }), file.name);
    form.set('messageId', messageId);
    form.set('filenameCiphertext', filenameCiphertext);
    form.set('wrappedFileKey', wrappedFileKey);
    const res = await fetch(`/portal/conversations/${id}/attachments`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!res.ok) {
      setUploadDetail(null);
      if (res.status === 422) {
        try {
          const body = (await res.json()) as { error?: string; signature?: string };
          if (body.error === 'infected') {
            setUploadDetail(body.signature ? `Match: ${body.signature}` : null);
            setUploadState('infected');
            return 'infected';
          }
          if (body.error === 'attachment_limit_reached') {
            setUploadDetail('Server attachment cap reached');
            setUploadState('blocked');
            return 'blocked';
          }
        } catch {
          /* fall through */
        }
      }
      if (res.status === 503) {
        // portalUpload.ts returns 503 when ClamAV can't scan. We refuse to
        // ship unscanned bytes — the user should retry shortly.
        setUploadState('scanUnavailable');
        return 'scanUnavailable';
      }
      setUploadState('blocked');
      return 'blocked';
    }
    setUploadState('scanning');
    try {
      const body = (await res.json()) as { scanStatus?: string };
      const final = body.scanStatus === 'infected' ? 'infected' : 'done';
      setUploadState(final);
      return final;
    } catch {
      setUploadState('done');
      return 'done';
    }
  }

  if (!detail) return <div className="bg-white rounded shadow p-5 text-sm">Loading…</div>;
  if (detail.stepupRequired) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded shadow p-5">
        <h2 className="font-semibold mb-1">Verify your identity</h2>
        <p className="text-sm text-amber-900 mb-3">
          Your firm requires identity verification before you can read this conversation.
        </p>
        <a href="/stepup" className="text-brand-700 underline text-sm">
          Continue to verification →
        </a>
      </div>
    );
  }

  return (
    <div className="bg-white rounded shadow divide-y divide-slate-100">
      <div className="px-4 py-3 flex items-center gap-2">
        <span className="font-semibold flex-1 truncate">
          {detail.displayName ?? 'Conversation'}
        </span>
        {/* Phase 24: Requests pill. Hidden entirely when the firm-wide kill
            switch is off; otherwise always visible — the panel itself shows
            "no open requests" when there's nothing to show, which beats
            asking the panel to load + count just to decide whether to render
            the button. */}
        {!requestsDisabled && (
          <button
            type="button"
            onClick={() => setRequestsOpen(true)}
            className="text-xs rounded-md bg-brand-50 text-brand-700 px-3 py-1 font-medium hover:bg-brand-100"
          >
            Requests
          </button>
        )}
      </div>
      <div className="p-4 space-y-2 max-h-[55vh] overflow-y-auto">
        {messages.map((m) => {
          // "Mine" = this session's identity. Pre-fix this was any external
          // identity which mis-coloured messages from other clients in the
          // same conversation as if the current user had sent them.
          const mine = m.senderExternalIdentityId === myIdentityId;
          // Bridged-pending: the message body is sealed to the firm key, not
          // the conversation key, so nothing in this browser can open it.
          // Hide attachments + skip the "(unable to decrypt)" fallback since
          // we already show a purpose-built pill + placeholder body.
          const isBridgePending =
            m.contentKeyVersion === 0 && (m.source === 'email-in' || m.source === 'sms-in');
          const renderedBody = decryptedBodies[m.id];
          return (
            <div
              key={m.id}
              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                mine ? 'bg-brand-600 text-white ml-auto' : 'bg-slate-100'
              }`}
            >
              {m.source !== 'app' && m.source !== 'system' && (
                // BRIDGE: bridged-in messages are not E2EE. CLAUDE.md requires a
                // visible indicator; a coloured pill that survives any bubble
                // background reads better than a low-contrast byline.
                <div
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold mb-1 ${
                    mine ? 'bg-amber-400/30 text-amber-50' : 'bg-amber-100 text-amber-900'
                  }`}
                  title="This message arrived via email or SMS and is not end-to-end encrypted."
                >
                  <span aria-hidden="true">{m.source === 'email-in' ? '✉' : '💬'}</span>
                  <span>Bridged {m.source === 'email-in' ? 'email' : 'SMS'}</span>
                </div>
              )}
              {m.deletedAt || renderedBody === '__deleted__' ? (
                <span className="italic opacity-70">Message deleted</span>
              ) : renderedBody === '__decrypting__' || renderedBody === undefined ? (
                <span className="italic opacity-60">decrypting…</span>
              ) : (
                renderedBody
              )}
              {!isBridgePending && !m.deletedAt && m.attachments && m.attachments.length > 0 && (
                <div
                  className={`mt-1 space-y-1 ${renderedBody && renderedBody !== '__decrypting__' ? 'pt-2 border-t border-white/20' : ''}`}
                >
                  {m.attachments.map((att) => (
                    <PortalAttachmentView
                      key={att.id}
                      attachment={att}
                      mine={mine}
                      onDownload={() => void downloadAttachment(att)}
                      onDownloadAsPdf={() => void downloadImageAsPdf(att)}
                      decryptAttachmentBytes={decryptAttachmentBytes}
                    />
                  ))}
                  <PortalMessageCombinePdfButton
                    msg={m}
                    mine={mine}
                    onCombine={() => void downloadMessageImagesAsPdf(m)}
                  />
                </div>
              )}
              <div className={`text-[10px] mt-1 ${mine ? 'opacity-80' : 'text-slate-400'}`}>
                {new Date(m.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {!m.deletedAt && m.editedAt && ' · edited'}
              </div>
            </div>
          );
        })}
        {messages.length === 0 && (
          <div className="text-sm text-slate-500 text-center py-6">No messages yet.</div>
        )}
      </div>
      {linkedItem && (
        <div className="px-3 py-2 bg-brand-50 border-t border-brand-200 text-xs text-brand-900 flex items-center gap-2">
          <span aria-hidden>📌</span>
          <span className="flex-1 min-w-0 truncate">
            Replying to <strong>{linkedItem.title}</strong>
            {linkedItem.responseType === 'file' && (
              <span className="ml-1 opacity-75">· attach a file to send</span>
            )}
            {linkedItem.responseType === 'text' && (
              <span className="ml-1 opacity-75">· type a note to send</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => setLinkedItem(null)}
            className="text-brand-700 hover:underline"
            aria-label="Unlink"
          >
            Cancel
          </button>
        </div>
      )}
      {pendingFiles.length > 0 && (
        <div className="px-3 py-2 border-t border-slate-200 bg-slate-50/50 flex flex-wrap gap-1.5">
          {pendingFiles.map((staged) => (
            <span
              key={staged.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-white border border-slate-300 px-2 py-1 text-[11px] text-slate-700"
              title={`${staged.file.name} · ${(staged.file.size / 1024).toFixed(0)} KB · encrypts on send`}
            >
              <span aria-hidden>📎</span>
              <span className="max-w-[120px] truncate">{staged.file.name}</span>
              <span className="text-slate-400">{(staged.file.size / 1024).toFixed(0)} KB</span>
              <button
                type="button"
                onClick={() => setPendingFiles((prev) => prev.filter((s) => s.id !== staged.id))}
                className="text-slate-400 hover:text-rose-700 leading-none"
                aria-label={`Remove ${staged.file.name}`}
              >
                ×
              </button>
            </span>
          ))}
          {pendingFiles.length >= PORTAL_MAX_ATTACHMENTS && (
            <span className="text-[11px] text-slate-500 self-center">
              Max {PORTAL_MAX_ATTACHMENTS} files per message
            </span>
          )}
        </div>
      )}
      <div className="p-3 flex items-start gap-2">
        <textarea
          rows={2}
          className="flex-1 resize-none rounded-md border border-slate-300 px-2 py-1 text-sm"
          placeholder={linkedItem ? `Reply for "${linkedItem.title}"` : 'Message'}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void sendMessage();
            }
          }}
        />
        <div className="flex flex-col gap-2">
          <label
            className={`text-xs rounded border border-slate-300 px-2 py-1 cursor-pointer hover:bg-slate-50 ${
              pendingFiles.length > 0
                ? 'bg-brand-50 text-brand-700 border-brand-300'
                : 'text-slate-600'
            }`}
            title={
              pendingFiles.length === 0
                ? 'Attach files'
                : `${pendingFiles.length} file${pendingFiles.length === 1 ? '' : 's'} attached (click Send)`
            }
          >
            {pendingFiles.length === 0
              ? 'Attach'
              : `📎 ${pendingFiles.length} file${pendingFiles.length === 1 ? '' : 's'}`}
            <input
              type="file"
              className="hidden"
              multiple
              accept=".pdf,.jpg,.jpeg,.png,.heic,.docx,.xlsx,.csv,.txt"
              onChange={(e) => {
                // Stage files locally — the upload runs after sendMessage
                // creates the real message id to attach to. Pre-fix the code
                // fired a fire-and-forget upload against the last-seen
                // messageId, which could be someone else's message.
                const picked = Array.from(e.target.files ?? []);
                if (picked.length > 0) {
                  setPendingFiles((prev) => {
                    const staged = picked.map(stageFile);
                    const merged = [...prev, ...staged];
                    if (merged.length > PORTAL_MAX_ATTACHMENTS) {
                      const dropped = merged.length - PORTAL_MAX_ATTACHMENTS;
                      // Surface the silent truncation so the user knows their
                      // overflow files weren't queued. combineError is
                      // semantically correct here — this is an attach-time
                      // warning, not a send failure.
                      setCombineError(
                        `Only ${PORTAL_MAX_ATTACHMENTS} files per submission — ${dropped} extra dropped.`,
                      );
                      return merged.slice(0, PORTAL_MAX_ATTACHMENTS);
                    }
                    return merged;
                  });
                }
                // Reset the input so picking the same filename again fires onChange.
                e.target.value = '';
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => void sendMessage()}
            disabled={
              !convKey ||
              (!body.trim() && pendingFiles.length === 0) ||
              !linkedItemSatisfied(linkedItem, body, pendingFiles)
            }
            className="rounded bg-brand-600 text-white text-sm px-3 py-1 hover:bg-brand-700 disabled:opacity-60"
          >
            Send
          </button>
        </div>
      </div>
      {uploadState !== 'idle' && (
        <div
          className={
            uploadState === 'infected'
              ? 'px-3 py-2 text-xs bg-rose-50 text-rose-800 border-t border-rose-200'
              : uploadState === 'blocked' || uploadState === 'scanUnavailable'
                ? 'px-3 py-2 text-xs bg-amber-50 text-amber-900 border-t border-amber-200'
                : 'px-3 py-2 text-xs text-slate-600'
          }
        >
          {uploadState === 'encrypting' && 'Encrypting…'}
          {uploadState === 'uploading' && 'Uploading…'}
          {uploadState === 'scanning' && 'Scanning for viruses…'}
          {uploadState === 'done' && 'Delivered ✓'}
          {uploadState === 'blocked' && 'Blocked (file type or size).'}
          {uploadState === 'scanUnavailable' &&
            'Virus scanner is temporarily unavailable. Please retry in a moment.'}
          {uploadState === 'infected' && (
            <>
              Rejected: virus scan flagged this file.
              {uploadDetail && <span className="ml-1 text-rose-600">{uploadDetail}</span>}
            </>
          )}
        </div>
      )}
      {sendError && (
        <div className="px-3 py-2 text-xs bg-rose-50 text-rose-900 border-t border-rose-200 flex items-start justify-between gap-2">
          <span>
            <span className="font-medium">Couldn&apos;t send:</span> {sendError}
            {linkedItem && (
              <span className="block text-[11px] text-rose-700/80 mt-0.5">
                Your pin to <strong>{linkedItem.title}</strong> is preserved — click Send again to
                retry.
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => setSendError(null)}
            className="text-rose-700 hover:text-rose-900 font-semibold"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      {combineError && (
        <div className="px-3 py-2 text-xs bg-amber-50 text-amber-900 border-t border-amber-200 flex items-start justify-between gap-2">
          <span>{combineError}</span>
          <button
            type="button"
            onClick={() => setCombineError(null)}
            className="text-amber-700 hover:text-amber-900 font-semibold"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <RequestsPanel
        conversationId={id}
        convKey={convKey}
        open={requestsOpen && !requestsDisabled}
        onClose={() => setRequestsOpen(false)}
        onPick={(item, path, file) => {
          // Wire the picked item back into the compose flow. The user can
          // adjust the body text or swap the file before hitting Send; the
          // ciphertextMeta.requestItemId pin survives until they cancel or
          // send. We stage but don't auto-send so the user can add a
          // sentence ("here's last year's W-2 for comparison") before
          // shipping.
          setLinkedItem(item);
          if ((path === 'photo' || path === 'file') && file) {
            setPendingFiles((prev) => [...prev, stageFile(file)].slice(0, PORTAL_MAX_ATTACHMENTS));
          }
        }}
      />
    </div>
  );
}

/**
 * Phase 24.5: enforces the per-item response_type rule on the Send button so
 * a client can't submit a `file`-only item with text-only content (or vice
 * versa). Returns true when no item is pinned (regular chat reply), or when
 * the staged content satisfies the linked item's rule.
 */
function linkedItemSatisfied(
  linkedItem: PickedItem | null,
  body: string,
  pendingFiles: { id: string; file: File }[],
): boolean {
  if (!linkedItem) return true;
  const hasText = body.trim().length > 0;
  const hasFiles = pendingFiles.length > 0;
  switch (linkedItem.responseType) {
    case 'file':
      return hasFiles;
    case 'text':
      return hasText;
    case 'both':
      return hasText || hasFiles;
  }
}

/**
 * Chooses between an inline image preview and a download chip. Image preview
 * is gated on: image/* MIME, clean scan status, and under the size cap. Any
 * decrypt failure falls through to the chip so the user always has access to
 * the bytes. Mirrors the equivalent component in the staff ConversationView.
 */
function PortalAttachmentView({
  attachment,
  mine,
  onDownload,
  onDownloadAsPdf,
  decryptAttachmentBytes,
}: {
  attachment: MsgAttachment;
  mine: boolean;
  onDownload: () => void;
  onDownloadAsPdf: () => void;
  decryptAttachmentBytes: (att: MsgAttachment) => Promise<Uint8Array | null>;
}): JSX.Element {
  const canPreview =
    attachment.scanStatus === 'clean' &&
    attachment.mimeType.startsWith('image/') &&
    attachment.sizeBytes <= PORTAL_INLINE_IMAGE_SIZE_CAP;
  if (canPreview) {
    return (
      <PortalAttachmentImagePreview
        attachment={attachment}
        mine={mine}
        onDownload={onDownload}
        onDownloadAsPdf={onDownloadAsPdf}
        decryptAttachmentBytes={decryptAttachmentBytes}
      />
    );
  }
  return <PortalAttachmentChip attachment={attachment} mine={mine} onDownload={onDownload} />;
}

function PortalAttachmentImagePreview({
  attachment,
  mine,
  onDownload,
  onDownloadAsPdf,
  decryptAttachmentBytes,
}: {
  attachment: MsgAttachment;
  mine: boolean;
  onDownload: () => void;
  onDownloadAsPdf: () => void;
  decryptAttachmentBytes: (att: MsgAttachment) => Promise<Uint8Array | null>;
}): JSX.Element {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    (async () => {
      try {
        const bytes = await decryptAttachmentBytes(attachment);
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
      if (createdUrl) setTimeout(() => URL.revokeObjectURL(createdUrl!), 0);
    };
  }, [attachment, decryptAttachmentBytes]);
  if (state === 'error') {
    return <PortalAttachmentChip attachment={attachment} mine={mine} onDownload={onDownload} />;
  }
  return (
    <figure className={`rounded-md overflow-hidden ${mine ? 'bg-brand-500/40' : 'bg-slate-200'}`}>
      <button type="button" onClick={onDownload} className="block w-full" title="Download image">
        {state === 'loading' || !url ? (
          <div className="aspect-[4/3] max-h-64 grid place-items-center text-xs opacity-70">
            Decrypting…
          </div>
        ) : (
          <img
            src={url}
            alt="attachment"
            className="max-h-64 max-w-full object-contain"
            loading="lazy"
          />
        )}
      </button>
      <figcaption
        className={`flex items-center gap-2 px-2 py-1 text-[10px] ${
          mine ? 'text-brand-50' : 'text-slate-600'
        }`}
      >
        <span className="flex-1 truncate">(encrypted image)</span>
        {/* JPEG + PNG only. pdf-lib's native embed APIs accept exactly those. */}
        {isPdfConvertibleInline(attachment.mimeType) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDownloadAsPdf();
            }}
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold hover:underline ${
              mine ? 'bg-brand-500/30 hover:bg-brand-500/60' : 'bg-slate-300 hover:bg-slate-400'
            }`}
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

function PortalAttachmentChip({
  attachment,
  mine,
  onDownload,
}: {
  attachment: MsgAttachment;
  mine: boolean;
  onDownload: () => void;
}): JSX.Element {
  const infected = attachment.scanStatus === 'infected';
  const pending = attachment.scanStatus === 'pending';
  return (
    <button
      type="button"
      onClick={infected || pending ? undefined : onDownload}
      disabled={infected || pending}
      className={`flex items-center gap-2 text-xs rounded-md px-2 py-1 w-full text-left ${
        mine
          ? 'bg-brand-500/40 hover:bg-brand-500/60 text-brand-50'
          : 'bg-slate-200 hover:bg-slate-300 text-slate-700'
      } ${infected ? 'bg-rose-100 text-rose-800 cursor-not-allowed' : ''} ${
        pending ? 'opacity-60 cursor-progress' : ''
      }`}
      title={infected ? 'Blocked by virus scan' : pending ? 'Scan pending' : 'Download'}
    >
      <span aria-hidden>{infected ? '⚠' : '📎'}</span>
      <span className="flex-1 truncate">(encrypted file)</span>
      <span className="text-[10px] opacity-70">{humanSize(attachment.sizeBytes)}</span>
    </button>
  );
}

/**
 * "Save all N images as one PDF" action below the attachment stack. Only
 * shown when a message has two or more eligible images; a single-image
 * message already exposes the per-image PDF button on its preview.
 */
function PortalMessageCombinePdfButton({
  msg,
  mine,
  onCombine,
}: {
  msg: Msg;
  mine: boolean;
  onCombine: () => void;
}): JSX.Element | null {
  const eligible = (msg.attachments ?? []).filter(
    (a) =>
      a.scanStatus === 'clean' &&
      isPdfConvertibleInline(a.mimeType) &&
      a.sizeBytes <= PORTAL_INLINE_IMAGE_SIZE_CAP,
  );
  if (eligible.length < 2) return null;
  return (
    <button
      type="button"
      onClick={onCombine}
      className={`block w-full text-left text-[11px] px-2 py-1 rounded-md hover:underline ${
        mine
          ? 'bg-brand-500/20 text-brand-50 hover:bg-brand-500/40'
          : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
      }`}
      title={`Combine ${eligible.length} images into a single PDF`}
    >
      📄 Save all {eligible.length} images as one PDF
    </button>
  );
}
