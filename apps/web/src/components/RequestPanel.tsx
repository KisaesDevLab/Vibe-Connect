// Phase 24.3 — Staff-side panel for managing a conversation's request lists.
//
// Renders inside ConversationView's right rail. Per the Phase 24 crypto
// split: list titles + descriptions are cleartext on the wire; item titles
// + descriptions + revision notes are E2EE under the conversation's content
// key, so this panel both decrypts on-display and encrypts on-create using
// the same envelope helpers as messages.
//
// Realtime: subscribes implicitly via useRealtime() — `request:changed`
// invalidates `request-lists/conv/<id>` and `request-list/<listId>` query
// keys, which trigger refetches here automatically.
//
// Templates + bulk dashboard land in 24.6; the New-list modal here just has
// a blank-list path for v1.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import type {
  CreateRequestItemBody,
  RequestItem,
  RequestItemStatus,
  RequestListWithItems,
  RequestResponseType,
  RequestTemplate,
} from '@vibe-connect/shared-types';
import { api } from '../api.js';
import { useCrypto } from '../state/crypto.js';

interface ConvKeyInputs {
  conversationId: string;
  wrappedKeys: Record<string, string> | null;
  rotationVersion: number | null;
}

interface Props extends ConvKeyInputs {
  /** Toggled from a button in ConversationView's header. */
  open: boolean;
  onClose: () => void;
}

/**
 * Hook that unwraps the active conversation key once per conversation and
 * exposes encrypt/decrypt helpers bound to it. Returns null when prerequisites
 * aren't ready (locked device, no wrappedKeys for this device).
 */
function useConversationKey(
  conversationId: string,
  wrappedKeys: Record<string, string> | null,
): {
  encryptText: ((plaintext: string) => Promise<string>) | null;
  decryptText: ((ciphertextBase64: string) => Promise<string>) | null;
  ready: boolean;
} {
  const { device, getSecretKey, recipientId } = useCrypto();
  const [keyState, setKeyState] = useState<{
    convKey: Uint8Array;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setKeyState(null);
    if (!device || !wrappedKeys) return;
    const rid = recipientId();
    if (!rid || !(rid in wrappedKeys)) return;
    const secret = getSecretKey();
    if (!secret) return;
    void (async () => {
      try {
        const c = await import('@vibe-connect/crypto');
        const convKey = await c.unwrapConversationKey(wrappedKeys, rid, device.publicKey, secret);
        if (!cancelled) setKeyState({ convKey });
      } catch {
        // Most often a stale rotationVersion (we'll get the next batch on
        // the conversation:rekey or wrapped-keys-updated socket event). Stay
        // null so the panel renders an unobtrusive "encrypted" placeholder.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, wrappedKeys, device, getSecretKey, recipientId]);

  const encryptText = useMemo(() => {
    if (!keyState) return null;
    return async (plaintext: string): Promise<string> => {
      const c = await import('@vibe-connect/crypto');
      const env = await c.encryptMessage(c.utf8Encode(plaintext), keyState.convKey, 1);
      return btoa(JSON.stringify(env));
    };
  }, [keyState]);
  const decryptText = useMemo(() => {
    if (!keyState) return null;
    return async (ciphertextBase64: string): Promise<string> => {
      try {
        const c = await import('@vibe-connect/crypto');
        const env = JSON.parse(atob(ciphertextBase64)) as Parameters<typeof c.decryptMessage>[0];
        const plain = await c.decryptMessage(env, keyState.convKey);
        return c.utf8Decode(plain);
      } catch {
        return '(encrypted — needs newer key)';
      }
    };
  }, [keyState]);
  return { encryptText, decryptText, ready: keyState !== null };
}

// ---------- UI helpers ----------

const STATUS_PILL: Record<RequestItemStatus, string> = {
  pending: 'bg-slate-100 text-slate-700 border-slate-200',
  submitted: 'bg-amber-50 text-amber-800 border-amber-200',
  done: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  revision: 'bg-rose-50 text-rose-800 border-rose-200',
};

const STATUS_LABEL: Record<RequestItemStatus, string> = {
  pending: 'Pending',
  submitted: 'Needs review',
  done: 'Done',
  revision: 'Revision sent',
};

function progressOf(items: RequestItem[]): { done: number; total: number; pct: number } {
  if (items.length === 0) return { done: 0, total: 0, pct: 0 };
  const done = items.filter((i) => i.status === 'done').length;
  return { done, total: items.length, pct: Math.round((done / items.length) * 100) };
}

// ---------- Component ----------

export function RequestPanel({
  conversationId,
  wrappedKeys,
  rotationVersion,
  open,
  onClose,
}: Props): JSX.Element | null {
  const qc = useQueryClient();
  const {
    encryptText,
    decryptText,
    ready: keyReady,
  } = useConversationKey(conversationId, wrappedKeys);

  const listsQ = useQuery({
    queryKey: ['request-lists', 'conv', conversationId],
    queryFn: () => api.requests.listForConversation(conversationId).then((r) => r.lists),
    enabled: open && Boolean(conversationId),
    staleTime: 15_000,
  });

  // Default-select: most recent active list, or the most recent overall.
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  useEffect(() => {
    const lists = listsQ.data ?? [];
    if (lists.length === 0) {
      setSelectedListId(null);
      return;
    }
    if (selectedListId && lists.some((l) => l.id === selectedListId)) return;
    const active = lists.find((l) => l.status === 'active');
    setSelectedListId((active ?? lists[0])!.id);
  }, [listsQ.data, selectedListId]);

  const detailQ = useQuery({
    queryKey: ['request-list', selectedListId],
    queryFn: () =>
      selectedListId
        ? api.requests.getList(selectedListId).then((r) => r.list)
        : Promise.resolve(null),
    enabled: Boolean(selectedListId),
  });

  const [newListOpen, setNewListOpen] = useState(false);
  const [revisionFor, setRevisionFor] = useState<RequestItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onMutationError = (err: unknown): void => {
    setError(err instanceof Error ? err.message : 'Request failed');
  };

  const markDoneMut = useMutation({
    mutationFn: (id: string) => api.requests.markDone(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['request-list', selectedListId] });
      void qc.invalidateQueries({ queryKey: ['request-lists', 'conv', conversationId] });
    },
    onError: onMutationError,
  });
  const deleteItemMut = useMutation({
    mutationFn: (id: string) => api.requests.deleteItem(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['request-list', selectedListId] });
    },
    onError: onMutationError,
  });
  const cancelListMut = useMutation({
    mutationFn: (id: string) => api.requests.cancelList(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['request-lists', 'conv', conversationId] });
      void qc.invalidateQueries({ queryKey: ['request-list', selectedListId] });
    },
    onError: onMutationError,
  });
  const nudgeMut = useMutation({
    mutationFn: (listId: string) => api.requests.nudge(listId, { channel: 'all' }),
    onError: (err: Error) => {
      // The API maps rate-limit collisions to 429; surface that instead of
      // the generic "Request failed" string so the staff can see why.
      setError(
        err.message === '429' ? 'Already nudged 3 times in the last 24 hours.' : err.message,
      );
    },
    onSuccess: () => setError(null),
  });

  if (!open) return null;

  return (
    <aside
      className="
        bg-white border-slate-200 flex flex-col overflow-hidden
        fixed inset-0 z-40 w-full border-l-0
        md:static md:z-auto md:w-[340px] md:h-full md:flex-shrink-0 md:border-l
      "
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <div>
          <h3 className="font-semibold text-sm text-slate-900">Requests</h3>
          <p className="text-[11px] text-slate-500">Track what you&apos;ve asked from the client</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close requests panel"
          className="text-slate-500 hover:text-slate-800 px-1"
        >
          ×
        </button>
      </header>

      {!keyReady && (
        <div className="px-4 py-3 text-xs text-amber-800 bg-amber-50 border-b border-amber-200">
          Unlocking the conversation key… item details will decrypt momentarily.
        </div>
      )}

      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 bg-slate-50/50">
        <select
          className="flex-1 text-xs rounded-md border border-slate-300 px-2 py-1 bg-white"
          value={selectedListId ?? ''}
          onChange={(e) => setSelectedListId(e.target.value || null)}
          disabled={!listsQ.data || listsQ.data.length === 0}
        >
          {(listsQ.data ?? []).length === 0 && <option value="">No lists yet</option>}
          {(listsQ.data ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.title}
              {l.status !== 'active' ? ` (${l.status})` : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setNewListOpen(true)}
          disabled={!encryptText || rotationVersion === null}
          className="ml-2 text-xs rounded-md bg-brand-600 text-white px-3 py-1 hover:bg-brand-700 disabled:bg-slate-300"
        >
          + New
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-2 text-xs rounded-md border border-rose-200 bg-rose-50 text-rose-800 px-3 py-2 flex justify-between gap-2">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {detailQ.data ? (
          <ListDetail
            list={detailQ.data}
            decryptText={decryptText}
            onMarkDone={(id) => markDoneMut.mutate(id)}
            onDelete={(id) => deleteItemMut.mutate(id)}
            onRequestRevision={(item) => setRevisionFor(item)}
            onCancelList={() => cancelListMut.mutate(detailQ.data!.id)}
            onNudge={() => nudgeMut.mutate(detailQ.data!.id)}
            nudging={nudgeMut.isPending}
          />
        ) : (
          <div className="p-6 text-xs text-slate-500 text-center">
            {listsQ.isLoading ? 'Loading…' : 'Pick a list above, or create a new one.'}
          </div>
        )}
      </div>

      {newListOpen && encryptText && rotationVersion !== null && (
        <NewListModal
          conversationId={conversationId}
          encryptText={encryptText}
          rotationVersion={rotationVersion}
          onClose={() => setNewListOpen(false)}
          onCreated={(list) => {
            setNewListOpen(false);
            setSelectedListId(list.id);
            void qc.invalidateQueries({
              queryKey: ['request-lists', 'conv', conversationId],
            });
          }}
        />
      )}

      {revisionFor && encryptText && rotationVersion !== null && (
        <RevisionModal
          item={revisionFor}
          encryptText={encryptText}
          rotationVersion={rotationVersion}
          onClose={() => setRevisionFor(null)}
          onDone={() => {
            setRevisionFor(null);
            void qc.invalidateQueries({ queryKey: ['request-list', selectedListId] });
          }}
        />
      )}
    </aside>
  );
}

// ---------- List + items ----------

function ListDetail({
  list,
  decryptText,
  onMarkDone,
  onDelete,
  onRequestRevision,
  onCancelList,
  onNudge,
  nudging,
}: {
  list: RequestListWithItems;
  decryptText: ((b64: string) => Promise<string>) | null;
  onMarkDone: (id: string) => void;
  onDelete: (id: string) => void;
  onRequestRevision: (item: RequestItem) => void;
  onCancelList: () => void;
  onNudge: () => void;
  nudging: boolean;
}): JSX.Element {
  const progress = progressOf(list.items);
  const hasOpenWork = list.items.some((i) => i.status === 'pending' || i.status === 'revision');
  return (
    <div className="px-4 py-3 space-y-3">
      <div>
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-slate-900 truncate">{list.title}</h4>
          <div className="flex items-center gap-2">
            {list.status === 'active' && hasOpenWork && (
              <button
                type="button"
                onClick={onNudge}
                disabled={nudging}
                className="text-[11px] rounded border border-brand-300 bg-brand-50 text-brand-800 px-2 py-0.5 hover:bg-brand-100 disabled:opacity-50"
                title="Send a reminder via the client's preferred channels"
              >
                {nudging ? 'Sending…' : 'Nudge'}
              </button>
            )}
            {list.status === 'active' && (
              <button
                type="button"
                onClick={() => {
                  if (confirm('Cancel this list? Items become read-only.')) onCancelList();
                }}
                className="text-[11px] text-slate-500 hover:text-rose-700"
              >
                Cancel list
              </button>
            )}
          </div>
        </div>
        {list.description && (
          <p className="text-[11px] text-slate-600 mt-0.5">{list.description}</p>
        )}
        {list.dueDate && <p className="text-[11px] text-slate-500 mt-0.5">Due {list.dueDate}</p>}
      </div>
      <div>
        <div className="flex items-center justify-between text-[11px] text-slate-600 mb-1">
          <span>
            {progress.done} of {progress.total} done
          </span>
          <span>{progress.pct}%</span>
        </div>
        <div className="h-1.5 bg-slate-100 rounded">
          <div
            className="h-1.5 bg-emerald-500 rounded transition-[width]"
            style={{ width: `${progress.pct}%` }}
          />
        </div>
      </div>
      <ul className="space-y-2">
        {list.items.length === 0 && (
          <li className="text-[11px] text-slate-500 text-center py-4">
            No items yet on this list.
          </li>
        )}
        {list.items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            decryptText={decryptText}
            onMarkDone={onMarkDone}
            onDelete={onDelete}
            onRequestRevision={onRequestRevision}
          />
        ))}
      </ul>
    </div>
  );
}

function ItemRow({
  item,
  decryptText,
  onMarkDone,
  onDelete,
  onRequestRevision,
}: {
  item: RequestItem;
  decryptText: ((b64: string) => Promise<string>) | null;
  onMarkDone: (id: string) => void;
  onDelete: (id: string) => void;
  onRequestRevision: (item: RequestItem) => void;
}): JSX.Element {
  const [title, setTitle] = useState<string>('…');
  const [description, setDescription] = useState<string | null>(null);
  const [revisionNote, setRevisionNote] = useState<string | null>(null);
  useEffect(() => {
    if (!decryptText) return;
    let cancelled = false;
    void decryptText(item.titleCiphertext).then((t) => {
      if (!cancelled) setTitle(t);
    });
    if (item.descriptionCiphertext) {
      void decryptText(item.descriptionCiphertext).then((d) => {
        if (!cancelled) setDescription(d);
      });
    } else {
      setDescription(null);
    }
    if (item.revisionNoteCiphertext) {
      void decryptText(item.revisionNoteCiphertext).then((r) => {
        if (!cancelled) setRevisionNote(r);
      });
    } else {
      setRevisionNote(null);
    }
    return () => {
      cancelled = true;
    };
  }, [decryptText, item.titleCiphertext, item.descriptionCiphertext, item.revisionNoteCiphertext]);
  return (
    <li className="rounded-md border border-slate-200 bg-white p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-800 truncate">{title}</span>
          </div>
          {description && <p className="text-[11px] text-slate-600 mt-0.5">{description}</p>}
          {item.dueDate && <p className="text-[10px] text-slate-500 mt-0.5">Due {item.dueDate}</p>}
          {revisionNote ? (
            <p className="text-[11px] text-rose-700 mt-1 bg-rose-50 border border-rose-100 rounded px-2 py-1">
              <span className="font-medium">Revision note:</span> {revisionNote}
            </p>
          ) : item.status === 'revision' ? (
            // Phase 24.5: server-walked-back state (most commonly an attachment
            // virus-scan failure). Server has no conversation key to write the
            // ciphertext note, so it leaves the field null and we render a
            // cleartext explainer.
            <p className="text-[11px] text-rose-700 mt-1 bg-rose-50 border border-rose-100 rounded px-2 py-1">
              Auto-reverted by virus scan or scan-unavailable error. Ask the client to re-upload.
            </p>
          ) : null}
        </div>
        <span
          className={clsx(
            'text-[10px] font-medium px-2 py-0.5 rounded border whitespace-nowrap',
            STATUS_PILL[item.status],
          )}
        >
          {STATUS_LABEL[item.status]}
        </span>
      </div>
      <div className="flex items-center justify-end gap-2 mt-2">
        {(item.status === 'submitted' || item.status === 'revision') && (
          <button
            type="button"
            onClick={() => onMarkDone(item.id)}
            className="text-[11px] rounded bg-emerald-600 text-white px-2 py-0.5 hover:bg-emerald-700"
          >
            Mark done
          </button>
        )}
        {(item.status === 'submitted' || item.status === 'done') && (
          <button
            type="button"
            onClick={() => onRequestRevision(item)}
            className="text-[11px] rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50"
          >
            Request revision
          </button>
        )}
        {item.status === 'pending' && (
          <button
            type="button"
            onClick={() => {
              if (confirm('Delete this item?')) onDelete(item.id);
            }}
            className="text-[11px] text-slate-500 hover:text-rose-700"
          >
            Delete
          </button>
        )}
      </div>
    </li>
  );
}

// ---------- New list modal ----------

interface DraftItem {
  title: string;
  description: string;
  responseType: RequestResponseType;
  dueDate: string;
}

function blankDraftItem(): DraftItem {
  return { title: '', description: '', responseType: 'both', dueDate: '' };
}

function NewListModal({
  conversationId,
  encryptText,
  rotationVersion,
  onClose,
  onCreated,
}: {
  conversationId: string;
  encryptText: (plaintext: string) => Promise<string>;
  rotationVersion: number;
  onClose: () => void;
  onCreated: (list: RequestListWithItems) => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [items, setItems] = useState<DraftItem[]>([blankDraftItem()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string>('');
  const templatesQ = useQuery({
    queryKey: ['request-templates'],
    queryFn: () => api.requests.listTemplates().then((r) => r.templates),
    staleTime: 60_000,
  });

  function applyTemplate(id: string): void {
    const t = (templatesQ.data ?? []).find((x: RequestTemplate) => x.id === id);
    if (!t) return;
    // Confirm before overwriting items the user has already typed. Anything
    // beyond an empty initial draft (one blank line, default response type)
    // counts as user data we shouldn't silently wipe.
    const userHasTyped = items.some(
      (i) => i.title.trim().length > 0 || i.description.trim().length > 0,
    );
    if (
      userHasTyped &&
      !confirm('Replace the items you typed with this template? Your draft items will be lost.')
    ) {
      return;
    }
    setTemplateId(id);
    if (!title) setTitle(t.name);
    if (!description && t.description) setDescription(t.description);
    setItems(
      t.itemSpecs.map((s) => ({
        title: s.title,
        description: s.description ?? '',
        responseType: s.responseType,
        dueDate: '',
      })),
    );
  }

  async function onSubmit(): Promise<void> {
    // Phase 24 follow-up: guard against double-submit. Two rapid Enter
    // presses can both reach this handler before `submitting=true` flushes
    // through React's render cycle, ending up creating two lists. The
    // disabled-on-button check is a render-time gate, not a function
    // entry guard.
    if (submitting) return;
    setError(null);
    if (!title.trim()) {
      setError('List title is required.');
      return;
    }
    const cleanItems = items.filter((i) => i.title.trim().length > 0);
    if (cleanItems.length === 0) {
      setError('Add at least one item.');
      return;
    }
    setSubmitting(true);
    try {
      const payloadItems: CreateRequestItemBody[] = [];
      for (const [idx, it] of cleanItems.entries()) {
        const titleCiphertext = await encryptText(it.title.trim());
        const descriptionCiphertext = it.description.trim()
          ? await encryptText(it.description.trim())
          : null;
        payloadItems.push({
          titleCiphertext,
          descriptionCiphertext,
          contentKeyVersion: rotationVersion,
          responseType: it.responseType,
          sortOrder: idx,
          dueDate: it.dueDate || null,
        });
      }
      const result = await api.requests.createList(conversationId, {
        title: title.trim(),
        description: description.trim() || null,
        dueDate: dueDate || null,
        templateId: templateId || null,
        items: payloadItems,
      });
      onCreated(result.list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create list.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center p-4 bg-slate-900/40"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
        className="w-full max-w-lg bg-white rounded-xl shadow-xl border border-slate-200 max-h-[80vh] flex flex-col"
      >
        <header className="px-4 py-3 border-b border-slate-200">
          <h3 className="font-semibold text-sm text-slate-900">New request list</h3>
          <p className="text-[11px] text-slate-500">
            Pick a template, or build a list from scratch. Item titles are end-to-end encrypted; the
            list title stays visible to the firm so reminders can name it.
          </p>
        </header>
        <div className="px-4 py-3 space-y-3 overflow-y-auto flex-1">
          <label className="block">
            <span className="text-[11px] text-slate-600">Template (optional)</span>
            <select
              value={templateId}
              onChange={(e) => {
                if (e.target.value) {
                  applyTemplate(e.target.value);
                } else if (templateId !== '') {
                  // Switching FROM a template back to "Blank list" — reset the
                  // items array so the user gets a clean draft instead of the
                  // old template's leftovers. Confirm if the items are dirty.
                  const dirty = items.some(
                    (i) => i.title.trim().length > 0 || i.description.trim().length > 0,
                  );
                  if (!dirty || confirm('Clear the prefilled items and start blank?')) {
                    setTemplateId('');
                    setItems([blankDraftItem()]);
                  }
                  // If the user declined, leave the dropdown reverting via React's
                  // controlled-component value sync (templateId stays the prior id).
                } else {
                  setTemplateId('');
                }
              }}
              className="mt-1 w-full rounded-md border border-slate-300 text-sm px-2 py-1.5 bg-white"
              disabled={!templatesQ.data || templatesQ.data.length === 0}
            >
              <option value="">Blank list</option>
              {(templatesQ.data ?? []).map((t: RequestTemplate) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-600">List title *</span>
            <input
              autoFocus
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="2024 Tax Documents"
              className="mt-1 w-full rounded-md border border-slate-300 text-sm px-2 py-1.5"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-600">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={2}
              className="mt-1 w-full rounded-md border border-slate-300 text-sm px-2 py-1.5"
            />
          </label>
          <label className="block w-1/2">
            <span className="text-[11px] text-slate-600">Due date</span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 text-sm px-2 py-1.5"
            />
          </label>
          <div>
            <div className="text-[11px] text-slate-600 mb-1">Items *</div>
            <ul className="space-y-2">
              {items.map((it, idx) => (
                <li
                  key={idx}
                  className="rounded-md border border-slate-200 p-2 space-y-1.5 bg-slate-50/50"
                >
                  <input
                    type="text"
                    value={it.title}
                    onChange={(e) =>
                      setItems((prev) =>
                        prev.map((p, i) => (i === idx ? { ...p, title: e.target.value } : p)),
                      )
                    }
                    maxLength={200}
                    placeholder="Item title (e.g. W-2 forms)"
                    className="w-full rounded border border-slate-300 text-sm px-2 py-1"
                  />
                  <input
                    type="text"
                    value={it.description}
                    onChange={(e) =>
                      setItems((prev) =>
                        prev.map((p, i) => (i === idx ? { ...p, description: e.target.value } : p)),
                      )
                    }
                    maxLength={2000}
                    placeholder="Description (optional)"
                    className="w-full rounded border border-slate-300 text-xs px-2 py-1"
                  />
                  <div className="flex items-center gap-2">
                    <select
                      value={it.responseType}
                      onChange={(e) =>
                        setItems((prev) =>
                          prev.map((p, i) =>
                            i === idx
                              ? { ...p, responseType: e.target.value as RequestResponseType }
                              : p,
                          ),
                        )
                      }
                      className="text-xs rounded border border-slate-300 px-1.5 py-0.5 bg-white"
                    >
                      <option value="both">File or text</option>
                      <option value="file">File only</option>
                      <option value="text">Text only</option>
                    </select>
                    <input
                      type="date"
                      value={it.dueDate}
                      onChange={(e) =>
                        setItems((prev) =>
                          prev.map((p, i) => (i === idx ? { ...p, dueDate: e.target.value } : p)),
                        )
                      }
                      className="text-xs rounded border border-slate-300 px-1.5 py-0.5"
                    />
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                        className="ml-auto text-[11px] text-slate-500 hover:text-rose-700"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setItems((prev) => [...prev, blankDraftItem()])}
              className="mt-2 text-[11px] text-brand-700 hover:underline"
            >
              + Add another item
            </button>
          </div>
          {error && <p className="text-xs text-rose-700">{error}</p>}
        </div>
        <footer className="px-4 py-3 border-t border-slate-200 bg-slate-50/50 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-xs rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="text-xs rounded-md bg-brand-600 text-white px-4 py-1.5 hover:bg-brand-700 disabled:bg-slate-300"
          >
            {submitting ? 'Creating…' : 'Create list'}
          </button>
        </footer>
      </form>
    </div>
  );
}

// ---------- Revision modal ----------

function RevisionModal({
  item,
  encryptText,
  rotationVersion,
  onClose,
  onDone,
}: {
  item: RequestItem;
  encryptText: (plaintext: string) => Promise<string>;
  rotationVersion: number;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(): Promise<void> {
    setError(null);
    if (!note.trim()) {
      setError('Please describe what needs to change.');
      return;
    }
    setSubmitting(true);
    try {
      const noteCiphertext = await encryptText(note.trim());
      await api.requests.requestRevision(item.id, {
        noteCiphertext,
        contentKeyVersion: rotationVersion,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request revision.');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center p-4 bg-slate-900/40"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="w-full max-w-md bg-white rounded-xl shadow-xl border border-slate-200"
      >
        <header className="px-4 py-3 border-b border-slate-200">
          <h3 className="font-semibold text-sm text-slate-900">Request revision</h3>
          <p className="text-[11px] text-slate-500">
            The client will get a thread message with your note and the item flips back to
            &ldquo;needs work&rdquo;.
          </p>
        </header>
        <div className="px-4 py-3 space-y-2">
          <label className="block">
            <span className="text-[11px] text-slate-600">What needs to change?</span>
            <textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              maxLength={500}
              className="mt-1 w-full rounded-md border border-slate-300 text-sm px-2 py-1.5"
            />
          </label>
          {error && <p className="text-xs text-rose-700">{error}</p>}
        </div>
        <footer className="px-4 py-3 border-t border-slate-200 bg-slate-50/50 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-xs rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="text-xs rounded-md bg-rose-600 text-white px-4 py-1.5 hover:bg-rose-700 disabled:bg-slate-300"
          >
            {submitting ? 'Sending…' : 'Send revision request'}
          </button>
        </footer>
      </form>
    </div>
  );
}
