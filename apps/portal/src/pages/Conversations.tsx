import { useEffect, useMemo, useState } from 'react';
import * as crypto from '@vibe-connect/crypto';
import { portalApi } from '../api.js';
import { getSessionKeys } from '../state/clientSession.js';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
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
}

interface ConvDetail {
  id: string;
  displayName: string | null;
  stepupRequired: boolean;
  rotationVersion: number | null;
  wrappedKeys: Record<string, string> | null;
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
}

export function ConversationsPage(): JSX.Element {
  const [me, setMe] = useState<{ displayName: string; verifiedUntil: string | null } | null>(null);
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    portalApi
      .me()
      .then((r) =>
        setMe(
          r.identity
            ? { displayName: r.identity.displayName, verifiedUntil: r.session.verifiedUntil }
            : null,
        ),
      )
      .catch(() => setMe(null));
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
            onClick={() => portalApi.logout().then(() => (window.location.href = '/'))}
            className="text-brand-700 hover:underline"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="max-w-2xl mx-auto p-4 space-y-3">
        <ul className="bg-white rounded shadow divide-y divide-slate-100">
          {convs.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setActiveId(c.id)}
                className={`w-full text-left px-4 py-3 hover:bg-slate-50 ${
                  activeId === c.id ? 'bg-brand-50' : ''
                }`}
              >
                <div className="font-medium">{c.displayName ?? '(conversation)'}</div>
                <div className="text-xs text-slate-500">
                  {new Date(c.updatedAt).toLocaleString()}
                </div>
              </button>
            </li>
          ))}
          {convs.length === 0 && (
            <li className="px-4 py-6 text-sm text-slate-500 text-center">No conversations yet.</li>
          )}
        </ul>
        {activeId && <ActiveConversation id={activeId} />}
      </main>
    </div>
  );
}

function ActiveConversation({ id }: { id: string }): JSX.Element {
  const [detail, setDetail] = useState<ConvDetail | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [convKey, setConvKey] = useState<Uint8Array | null>(null);
  const [decryptedBodies, setDecryptedBodies] = useState<Record<string, string>>({});
  const [body, setBody] = useState('');
  const [uploadState, setUploadState] = useState<
    'idle' | 'encrypting' | 'uploading' | 'scanning' | 'done' | 'blocked'
  >('idle');
  const session = useMemo(() => getSessionKeys(), []);

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

  useEffect(() => {
    if (!detail || !session || !detail.wrappedKeys) return;
    (async () => {
      await crypto.ready();
      const wrappedKey = Object.values(detail.wrappedKeys!)[0];
      // Find our session's slot by iterating entries; server records by session id, but the
      // session id is exposed via cookie lookup — for Phase 21 we fall back to "try every entry".
      // Production: server returns `{ [sessionId]: wrapped }` and we know our session id.
      for (const [, wrapped] of Object.entries(detail.wrappedKeys!)) {
        try {
          const k = await crypto.unwrapKey(wrapped, session.publicKey, session.secretKey);
          setConvKey(k);
          break;
        } catch {
          /* try next */
        }
      }
      void wrappedKey;
    })();
  }, [detail, session]);

  useEffect(() => {
    if (!convKey || messages.length === 0) return;
    (async () => {
      const out: Record<string, string> = {};
      for (const m of messages) {
        try {
          const env = JSON.parse(atob(m.ciphertext)) as crypto.SymmetricEnvelope;
          const plain = await crypto.decryptMessage(env, convKey);
          out[m.id] = crypto.utf8Decode(plain);
        } catch {
          out[m.id] = '(unable to decrypt)';
        }
      }
      setDecryptedBodies(out);
    })();
  }, [convKey, messages]);

  async function sendMessage(): Promise<void> {
    if (!convKey || !detail || !body.trim()) return;
    const env = await crypto.encryptMessage(
      crypto.utf8Encode(body.trim()),
      convKey,
      detail.rotationVersion ?? 1,
    );
    const ciphertext = btoa(JSON.stringify(env));
    await fetch(`/portal/conversations/${id}/messages`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciphertext, contentKeyVersion: detail.rotationVersion ?? 1 }),
    });
    setBody('');
    const reload = await json<{ messages: Msg[] }>(`/portal/conversations/${id}/messages`);
    setMessages(reload.messages);
  }

  async function uploadFile(file: File, messageId: string): Promise<void> {
    if (!convKey) return;
    setUploadState('encrypting');
    const fileKey = await crypto.generateSymmetricKey();
    const env = await crypto.encryptMessage(new Uint8Array(await file.arrayBuffer()), fileKey, 1);
    const wrappedFileKey = await crypto.wrapKey(
      fileKey,
      // Wrap the file key to the conversation key (as a symmetric secretbox via secretboxEncrypt
      // path). Using sealed box here would require a recipient public key; for attachments we
      // wrap to our own session pubkey and include it in `wrappedFileKey`.
      session!.publicKey,
    );
    setUploadState('uploading');
    const form = new FormData();
    form.set('file', new Blob([JSON.stringify(env)], { type: file.type }), file.name);
    form.set('messageId', messageId);
    form.set('filenameCiphertext', btoa(file.name));
    form.set('wrappedFileKey', wrappedFileKey);
    const res = await fetch(`/portal/conversations/${id}/attachments`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!res.ok) {
      setUploadState('blocked');
      return;
    }
    setUploadState('scanning');
    setTimeout(() => setUploadState('done'), 400);
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
      <div className="px-4 py-3 font-semibold">{detail.displayName ?? 'Conversation'}</div>
      <div className="p-4 space-y-2 max-h-[55vh] overflow-y-auto">
        {messages.map((m) => {
          const mine = Boolean(m.senderExternalIdentityId);
          return (
            <div
              key={m.id}
              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                mine ? 'bg-brand-600 text-white ml-auto' : 'bg-slate-100'
              }`}
            >
              {m.source !== 'app' && (
                <div className="text-[11px] opacity-70 mb-1">via {m.source.replace('-in', '')}</div>
              )}
              {decryptedBodies[m.id] ?? <span className="italic opacity-60">decrypting…</span>}
              <div className={`text-[10px] mt-1 ${mine ? 'opacity-80' : 'text-slate-400'}`}>
                {new Date(m.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            </div>
          );
        })}
        {messages.length === 0 && (
          <div className="text-sm text-slate-500 text-center py-6">No messages yet.</div>
        )}
      </div>
      <div className="p-3 flex items-start gap-2">
        <textarea
          rows={2}
          className="flex-1 resize-none rounded-md border border-slate-300 px-2 py-1 text-sm"
          placeholder="Message"
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
          <label className="text-xs text-slate-600 rounded border border-slate-300 px-2 py-1 cursor-pointer hover:bg-slate-50">
            Attach
            <input
              type="file"
              className="hidden"
              accept=".pdf,.jpg,.jpeg,.png,.heic,.docx,.xlsx,.csv,.txt"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadFile(f, messages.at(-1)?.id ?? crypto.newDeviceId());
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => void sendMessage()}
            disabled={!body.trim() || !convKey}
            className="rounded bg-brand-600 text-white text-sm px-3 py-1 hover:bg-brand-700 disabled:opacity-60"
          >
            Send
          </button>
        </div>
      </div>
      {uploadState !== 'idle' && (
        <div className="px-3 py-2 text-xs text-slate-600">
          {uploadState === 'encrypting' && 'Encrypting…'}
          {uploadState === 'uploading' && 'Uploading…'}
          {uploadState === 'scanning' && 'Scanning for viruses…'}
          {uploadState === 'done' && 'Delivered ✓'}
          {uploadState === 'blocked' && 'Blocked (file type or size).'}
        </div>
      )}
    </div>
  );
}
