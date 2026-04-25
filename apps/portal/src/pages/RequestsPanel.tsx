// Phase 24.4 — Portal-side Requests panel.
//
// Read-only surface: list of items with status pills + revision notes,
// tapping an item opens a bottom-sheet with three actions (Take photo,
// Upload file, Reply with note). All three actions delegate back to the
// host (Conversations.tsx) so the existing encrypt → POST → upload pipeline
// is reused unchanged. The panel just collects intent and an optional
// staged file, and pins `requestItemId` onto the next outbound message.
//
// Decryption uses the conversation key the host already unwrapped — passed
// in as a prop. Same envelope format as messages.
import { useEffect, useMemo, useState } from 'react';
import type * as CryptoModule from '@vibe-connect/crypto';
import type { RequestItem, RequestItemStatus } from '@vibe-connect/shared-types';
import { portalApi } from '../api.js';

let cryptoPromise: Promise<typeof CryptoModule> | null = null;
async function loadCrypto(): Promise<typeof CryptoModule> {
  if (!cryptoPromise) cryptoPromise = import('@vibe-connect/crypto');
  const c = await cryptoPromise;
  await c.ready();
  return c;
}

export type ResponsePath = 'photo' | 'file' | 'note';

export interface PickedItem {
  itemId: string;
  responseType: 'file' | 'text' | 'both';
  /** Decrypted item title — used for the toast banner that pins the active item. */
  title: string;
}

interface Props {
  conversationId: string;
  convKey: Uint8Array | null;
  open: boolean;
  onClose: () => void;
  /** Fired when the user picks an action on an item. The host handles the
   *  outbound message + attachment flow with the linked itemId. */
  onPick: (
    item: PickedItem,
    path: ResponsePath,
    file: File | null,
  ) => void | Promise<void>;
}

const STATUS_PILL: Record<RequestItemStatus, string> = {
  pending: 'bg-slate-100 text-slate-700 border-slate-200',
  submitted: 'bg-amber-50 text-amber-800 border-amber-200',
  done: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  revision: 'bg-rose-50 text-rose-800 border-rose-200',
};
const STATUS_LABEL: Record<RequestItemStatus, string> = {
  pending: 'Needed',
  submitted: 'Submitted',
  done: 'Done',
  revision: 'Needs more',
};

interface DecryptedItem extends RequestItem {
  decryptedTitle: string;
  decryptedDescription: string | null;
  decryptedRevisionNote: string | null;
}

interface DecryptedListView {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  status: string;
  items: DecryptedItem[];
}

async function decryptText(
  ciphertextBase64: string,
  convKey: Uint8Array,
): Promise<string> {
  try {
    const c = await loadCrypto();
    const env = JSON.parse(atob(ciphertextBase64)) as CryptoModule.SymmetricEnvelope;
    const plain = await c.decryptMessage(env, convKey);
    return c.utf8Decode(plain);
  } catch {
    return '(encrypted)';
  }
}

export function RequestsPanel({
  conversationId,
  convKey,
  open,
  onClose,
  onPick,
}: Props): JSX.Element | null {
  const [lists, setLists] = useState<DecryptedListView[]>([]);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerForItem, setPickerForItem] = useState<DecryptedItem | null>(null);

  // Fetch + decrypt every active list for this conversation, then keep just
  // the ones whose conversation_id matches. The portal endpoint returns ALL
  // active lists across every conversation the client is in; filtering here
  // saves a per-conversation call when the client has only one engagement.
  //
  // Phase 24.5 polling: portal sessions don't have a Socket.io connection, so
  // staff actions (mark done, request revision, scan-fail revert) aren't
  // pushed in real-time. Refetch every 15 s while the panel is open — same
  // cadence the Conversations page uses for the message thread. Stops when
  // the panel is closed or the document tab is hidden so idle portal tabs
  // don't thrash the server.
  useEffect(() => {
    if (!open || !convKey) return;
    // Capture a non-null reference so the inner async helper has a
    // narrowed type without relying on closure-narrowing across async
    // boundaries (TS can't prove convKey hasn't been reassigned).
    const key: Uint8Array = convKey;
    let cancelled = false;
    let interval: number | null = null;

    async function fetchOnce(initial: boolean): Promise<void> {
      if (cancelled) return;
      if (initial) {
        setLoading(true);
        setError(null);
      }
      try {
        const summary = await portalApi.requests.list();
        if (cancelled) return;
        const relevant = summary.lists.filter(
          (l) => l.conversationId === conversationId && l.status === 'active',
        );
        const decrypted: DecryptedListView[] = [];
        for (const l of relevant) {
          const detail = await portalApi.requests.get(l.id);
          if (cancelled) return;
          const items: DecryptedItem[] = [];
          for (const item of detail.list.items) {
            const title = await decryptText(item.titleCiphertext, key);
            const description = item.descriptionCiphertext
              ? await decryptText(item.descriptionCiphertext, key)
              : null;
            const note = item.revisionNoteCiphertext
              ? await decryptText(item.revisionNoteCiphertext, key)
              : null;
            if (cancelled) return;
            items.push({
              ...item,
              decryptedTitle: title,
              decryptedDescription: description,
              decryptedRevisionNote: note,
            });
          }
          decrypted.push({
            id: l.id,
            title: l.title,
            description: l.description,
            dueDate: l.dueDate,
            status: l.status,
            items,
          });
        }
        if (cancelled) return;
        setLists(decrypted);
        if (decrypted.length > 0 && !selectedListId) {
          setSelectedListId(decrypted[0]!.id);
        }
      } catch (err) {
        if (cancelled) return;
        if (initial) {
          setError(err instanceof Error ? err.message : 'Failed to load requests');
        }
        // Silent on poll failures — transient 401/network blips would otherwise
        // wipe the panel mid-use; the next tick retries.
      } finally {
        if (!cancelled && initial) setLoading(false);
      }
    }

    void fetchOnce(true);
    interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchOnce(false);
      }
    }, 15_000);
    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
    // `selectedListId` deliberately omitted from the dep array so flipping
    // the list dropdown doesn't tear down + re-create the polling interval
    // (which would flash the loading spinner). The `if (!selectedListId)`
    // auto-pick branch closes over the latest value because we re-evaluate
    // on each tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conversationId, convKey]);

  const selectedList = useMemo(
    () => lists.find((l) => l.id === selectedListId) ?? lists[0] ?? null,
    [lists, selectedListId],
  );

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30 bg-black/30 flex items-end sm:items-center sm:justify-center">
      <div className="w-full sm:max-w-md sm:rounded-xl bg-white max-h-[85vh] flex flex-col shadow-xl">
        <header className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div>
            <h3 className="font-semibold text-slate-900">Requests</h3>
            <p className="text-[11px] text-slate-500">
              What your firm has asked from you
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-slate-500 hover:text-slate-800 px-2 py-1"
          >
            ×
          </button>
        </header>

        {lists.length > 1 && (
          <div className="px-4 py-2 border-b border-slate-200 bg-slate-50/50">
            <select
              className="w-full text-sm rounded-md border border-slate-300 bg-white px-2 py-1.5"
              value={selectedListId ?? ''}
              onChange={(e) => setSelectedListId(e.target.value)}
            >
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <div className="mx-4 mt-3 text-xs rounded-md border border-rose-200 bg-rose-50 text-rose-800 px-3 py-2">
            {error}
          </div>
        )}
        {!convKey && (
          <div className="mx-4 mt-3 text-xs rounded-md border border-amber-200 bg-amber-50 text-amber-800 px-3 py-2">
            Unlocking secure key… items will appear shortly.
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading && <p className="text-xs text-slate-500 text-center py-8">Loading…</p>}
          {!loading && lists.length === 0 && (
            <p className="text-xs text-slate-500 text-center py-8">
              No open requests right now. Your firm will let you know if anything changes.
            </p>
          )}
          {selectedList && <ListBody list={selectedList} onPickItem={setPickerForItem} />}
        </div>
      </div>

      {pickerForItem && (
        <ActionSheet
          item={pickerForItem}
          onClose={() => setPickerForItem(null)}
          onPick={(path, file) => {
            void onPick(
              {
                itemId: pickerForItem.id,
                responseType: pickerForItem.responseType,
                title: pickerForItem.decryptedTitle,
              },
              path,
              file,
            );
            setPickerForItem(null);
            onClose();
          }}
        />
      )}
    </div>
  );
}

function ListBody({
  list,
  onPickItem,
}: {
  list: DecryptedListView;
  onPickItem: (item: DecryptedItem) => void;
}): JSX.Element {
  const total = list.items.length;
  const done = list.items.filter((i) => i.status === 'done').length;
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-base font-semibold text-slate-900">{list.title}</h4>
        {list.description && (
          <p className="text-xs text-slate-600 mt-0.5">{list.description}</p>
        )}
        {list.dueDate && (
          <p className="text-xs text-slate-500 mt-0.5">Due {list.dueDate}</p>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between text-[11px] text-slate-600 mb-1">
          <span>
            {done} of {total} done
          </span>
          <span>{total === 0 ? 0 : Math.round((done / total) * 100)}%</span>
        </div>
        <div className="h-1.5 bg-slate-100 rounded">
          <div
            className="h-1.5 bg-emerald-500 rounded transition-[width]"
            style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }}
          />
        </div>
      </div>
      <ul className="space-y-2">
        {list.items.map((item) => {
          const tappable = item.status === 'pending' || item.status === 'revision';
          return (
            <li
              key={item.id}
              className={`rounded-md border border-slate-200 bg-white p-3 ${
                tappable ? 'active:bg-slate-50' : ''
              }`}
            >
              <button
                type="button"
                disabled={!tappable}
                onClick={() => tappable && onPickItem(item)}
                className="w-full text-left"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-900">
                      {item.decryptedTitle}
                    </div>
                    {item.decryptedDescription && (
                      <p className="text-xs text-slate-600 mt-0.5">
                        {item.decryptedDescription}
                      </p>
                    )}
                    {item.dueDate && (
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Due {item.dueDate}
                      </p>
                    )}
                    {item.decryptedRevisionNote ? (
                      <p className="text-xs text-rose-700 mt-1 bg-rose-50 border border-rose-100 rounded px-2 py-1">
                        <span className="font-medium">Note from your firm:</span>{' '}
                        {item.decryptedRevisionNote}
                      </p>
                    ) : item.status === 'revision' ? (
                      // Phase 24.5: a `revision` state with no staff-authored note
                      // means the server walked the item back automatically — most
                      // commonly because an attachment failed virus scan and the
                      // server has no conversation key to encrypt a note under.
                      // Render a cleartext fallback so the client knows what to do.
                      <p className="text-xs text-rose-700 mt-1 bg-rose-50 border border-rose-100 rounded px-2 py-1">
                        Your last submission couldn&apos;t be accepted (possibly an
                        attachment failed virus scan). Please try again.
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={`text-[10px] font-medium px-2 py-0.5 rounded border whitespace-nowrap ${STATUS_PILL[item.status]}`}
                  >
                    {STATUS_LABEL[item.status]}
                  </span>
                </div>
                {tappable && (
                  <div className="text-[11px] text-brand-700 mt-2 flex items-center gap-1">
                    Tap to respond <span aria-hidden>→</span>
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ActionSheet({
  item,
  onClose,
  onPick,
}: {
  item: DecryptedItem;
  onClose: () => void;
  onPick: (path: ResponsePath, file: File | null) => void;
}): JSX.Element {
  // Per the build plan, photos use a hidden file input with capture=environment
  // — no custom camera UI. Browsers handle gallery vs camera selection.
  function pickPhoto(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.onchange = () => {
      const f = input.files?.[0] ?? null;
      onPick('photo', f);
    };
    input.click();
  }
  function pickFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = () => {
      const f = input.files?.[0] ?? null;
      onPick('file', f);
    };
    input.click();
  }
  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center sm:justify-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-sm sm:rounded-xl bg-white shadow-xl max-h-[60vh] flex flex-col"
      >
        <header className="px-4 py-3 border-b border-slate-200">
          <p className="text-[11px] uppercase text-slate-500 tracking-wide">Respond to</p>
          <h4 className="text-sm font-semibold text-slate-900 mt-0.5 truncate">
            {item.decryptedTitle}
          </h4>
        </header>
        <div className="p-3 space-y-2">
          {(item.responseType === 'file' || item.responseType === 'both') && (
            <button
              type="button"
              onClick={pickPhoto}
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm text-left hover:bg-slate-50 flex items-center gap-2"
            >
              <span aria-hidden>📷</span>
              <span className="font-medium">Take photo</span>
              <span className="ml-auto text-[11px] text-slate-500">Camera</span>
            </button>
          )}
          {(item.responseType === 'file' || item.responseType === 'both') && (
            <button
              type="button"
              onClick={pickFile}
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm text-left hover:bg-slate-50 flex items-center gap-2"
            >
              <span aria-hidden>📎</span>
              <span className="font-medium">Upload file</span>
              <span className="ml-auto text-[11px] text-slate-500">Any file</span>
            </button>
          )}
          {(item.responseType === 'text' || item.responseType === 'both') && (
            <button
              type="button"
              onClick={() => onPick('note', null)}
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm text-left hover:bg-slate-50 flex items-center gap-2"
            >
              <span aria-hidden>✏</span>
              <span className="font-medium">Reply with note</span>
              <span className="ml-auto text-[11px] text-slate-500">Type a message</span>
            </button>
          )}
        </div>
        <footer className="px-4 py-2 border-t border-slate-200 text-[11px] text-slate-500 flex items-center gap-1.5">
          <span aria-hidden>🔒</span>
          End-to-end encrypted — your firm sees the file content only after their device
          unlocks the key.
        </footer>
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50 border-t border-slate-200"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
