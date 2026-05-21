import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  clearScanBatch,
  loadScanBatch,
  saveScanBatch,
  type ScanPage,
} from '../lib/scanBatchStore.js';

/**
 * Phase 28.8 — multi-page scan batch review.
 *
 * Sits between the per-page ScannerReview (28.7) and the tus upload pipe
 * (28.5). Each confirmed scan from ScannerReview lands here via
 * `onAddPage` rather than going straight to upload, so the user can:
 *
 *   - Add more pages (button → reopens the camera flow)
 *   - Reorder pages by drag-and-drop
 *   - Retake a single page (replaces it in place, preserves order_index)
 *   - Delete a page with inline confirmation
 *   - Submit the whole batch — emits an ordered File[] for the caller to
 *     enqueue with `kind=scanned_image` + `orderIndex=position` metadata
 *   - Cancel: a confirmation modal asks before dropping captured pages
 *
 * IndexedDB persistence (`scanBatchStore.ts`) keeps the page list across
 * accidental tab refreshes within the same intake session. Submit and
 * Discard clear the store; stale-by-TTL records are dropped on load.
 *
 * Memory budget: pages are held as Blobs (browser-managed), thumbnails
 * as ~25KB JPEG data URLs. 20 pages × ~2 MB blob + 20 × 25 KB thumb
 * lands under 50 MB total — well below the 4 GB-RAM Android floor in
 * the build plan.
 */

export interface PendingPage {
  /** The original captured JPEG (not yet warped — the perspective
   *  transform now happens server-side, see
   *  apps/server/src/services/intakeScannerWarp.ts). The OS-camera
   *  fallback path also lands here with `scannerMeta` undefined. */
  file: File;
  /** Non-null when the parent asked for a retake of page N — we replace
   *  rather than append, preserving the original order_index. */
  replaceIndex: number | null;
  /** Monotonically-increasing sequence number bumped by the parent on
   *  every enqueue. The consume-effect keys off this so that two
   *  consecutive captures of the same File reference (rare but possible)
   *  still fire the effect. */
  seq: number;
  /** JSON-stringified `{quad, enhanceMode, sourceSize}` from
   *  ScannerReview. Absent when the page came from the OS camera (no
   *  corner-drag UI). The batch list keeps this paired with the blob so
   *  reorder/retake/submit preserves the right warp inputs per page. */
  scannerMeta?: string;
}

export interface ScanBatchProps {
  sessionId: string;
  /** Pending capture queued by the parent for inclusion in the batch.
   *  Null when nothing is pending. The child consumes it via useEffect
   *  and calls onPendingConsumed once persisted. */
  pendingPage: PendingPage | null;
  /** Called by the child once a pendingPage has been added/replaced and
   *  persisted to IDB. The parent must clear its own pending state in
   *  response so a stale pendingPage doesn't re-fire on every render. */
  onPendingConsumed: () => void;
  /** Called by the parent when the user wants to add a new page — the
   *  parent reopens the camera flow and the next captured + cropped file
   *  arrives as a new `pendingPage`. */
  onAddMore: () => void;
  /** Same idea but the parent should reopen the camera in "retake page N"
   *  mode; the new pendingPage will carry replaceIndex = N. */
  onRetakePage: (index: number) => void;
  /** User confirmed the batch — emit ordered pages (page 1 first). Each
   *  page carries the renamed File + the optional scannerMeta payload
   *  that the upload pipe forwards to the server as tus metadata. */
  onSubmit: (pages: Array<{ file: File; scannerMeta?: string }>) => void;
  /** User discarded the batch (after confirmation) — parent closes the
   *  batch view; the IDB record is already cleared. */
  onDiscard: () => void;
}

export function ScanBatch({
  sessionId,
  pendingPage,
  onPendingConsumed,
  onAddMore,
  onRetakePage,
  onSubmit,
  onDiscard,
}: ScanBatchProps): JSX.Element {
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Hydrate from IDB on mount. If the tab reloaded mid-review, the page
  // list comes back; otherwise empty and ready for fresh captures.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadScanBatch(sessionId);
      if (!cancelled && saved) {
        setPages(saved);
      }
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Persist on every mutation. Debouncing isn't worth it — IDB writes
  // run off the main thread and the user can only mutate one page at a
  // time anyway.
  useEffect(() => {
    if (!hydrated) return;
    void saveScanBatch(sessionId, pages);
  }, [sessionId, pages, hydrated]);

  const addPage = useCallback(async (file: File, scannerMeta?: string): Promise<void> => {
    const thumb = await makeThumbnail(file);
    setPages((prev) => [
      ...prev,
      {
        id: randomId(),
        blob: file,
        thumb,
        scannerMeta,
        capturedAt: Date.now(),
      },
    ]);
  }, []);

  const replacePage = useCallback(
    async (index: number, file: File, scannerMeta?: string): Promise<void> => {
      const thumb = await makeThumbnail(file);
      setPages((prev) => {
        const next = prev.slice();
        if (index < 0 || index >= next.length) return prev;
        next[index] = {
          id: next[index]!.id,
          blob: file,
          thumb,
          scannerMeta,
          capturedAt: Date.now(),
        };
        return next;
      });
    },
    [],
  );

  // Consume the parent's pendingPage handoff once hydration completes.
  // Guarded on `hydrated` so we don't append a capture that arrives
  // before the IDB load finishes (race the old imperative-ref pattern
  // had). Keyed on the parent's seq counter so identical Files still
  // fire on a second capture.
  const lastConsumedSeq = useRef<number | null>(null);
  useEffect(() => {
    if (!hydrated || !pendingPage) return;
    if (lastConsumedSeq.current === pendingPage.seq) return;
    lastConsumedSeq.current = pendingPage.seq;
    const { file, replaceIndex, scannerMeta } = pendingPage;
    void (async () => {
      try {
        if (replaceIndex !== null) {
          await replacePage(replaceIndex, file, scannerMeta);
        } else {
          await addPage(file, scannerMeta);
        }
      } finally {
        onPendingConsumed();
      }
    })();
  }, [hydrated, pendingPage, addPage, replacePage, onPendingConsumed]);

  function deletePage(id: string): void {
    setPages((prev) => prev.filter((p) => p.id !== id));
    setConfirmDeleteId(null);
  }

  function movePage(from: number, to: number): void {
    if (from === to) return;
    setPages((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      if (!moved) return prev;
      next.splice(to, 0, moved);
      return next;
    });
  }

  async function submit(): Promise<void> {
    const out = pages.map((p, i) => {
      const idx = String(i + 1).padStart(3, '0');
      const type = p.blob.type || 'image/jpeg';
      const ext = mimeToExt(type);
      const file = new File([p.blob], `scan-page-${idx}.${ext}`, {
        type,
        lastModified: p.capturedAt,
      });
      return { file, scannerMeta: p.scannerMeta };
    });
    await clearScanBatch(sessionId);
    onSubmit(out);
  }

  function mimeToExt(mime: string): string {
    switch (mime.toLowerCase()) {
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      case 'image/heic':
      case 'image/heif':
        return 'heic';
      case 'image/jpeg':
      case 'image/jpg':
      default:
        return 'jpg';
    }
  }

  async function discardConfirmed(): Promise<void> {
    setConfirmDiscard(false);
    await clearScanBatch(sessionId);
    onDiscard();
  }

  if (!hydrated) {
    return <div className="p-4 text-sm text-slate-500">Loading scans…</div>;
  }

  return (
    <div className="space-y-3">
      <header className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-900">Scanned pages</h2>
        <span className="text-sm text-slate-500" aria-live="polite">
          {pages.length} page{pages.length === 1 ? '' : 's'}
        </span>
      </header>

      {pages.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">
          No pages yet. Tap <strong>Add a page</strong> to start scanning.
        </div>
      ) : (
        <ul role="list" className="space-y-2">
          {pages.map((p, i) => (
            <li
              key={p.id}
              className="bg-white border border-slate-200 rounded-md p-3 flex items-center gap-3"
            >
              {/* Explicit up/down buttons rather than HTML5 draggable —
                  the drag API doesn't fire on touch, so on mobile the
                  prior drag-handle was a dead element. These work
                  everywhere; the row count is small so a Lego-block
                  reorder is fine UX. */}
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => movePage(i, i - 1)}
                  disabled={i === 0}
                  aria-label={`Move page ${i + 1} up`}
                  className="text-slate-500 hover:text-slate-800 disabled:opacity-30 disabled:cursor-not-allowed text-lg leading-none"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => movePage(i, i + 1)}
                  disabled={i === pages.length - 1}
                  aria-label={`Move page ${i + 1} down`}
                  className="text-slate-500 hover:text-slate-800 disabled:opacity-30 disabled:cursor-not-allowed text-lg leading-none"
                >
                  ↓
                </button>
              </div>
              <img
                src={p.thumb}
                alt={`Page ${i + 1} of ${pages.length}`}
                className="w-16 h-16 object-cover rounded border border-slate-200 bg-slate-50"
                draggable={false}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-900">Page {i + 1}</div>
                <div className="text-xs text-slate-500">{formatBytes(p.blob.size)}</div>
              </div>
              {confirmDeleteId === p.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-600">Delete?</span>
                  <button
                    type="button"
                    onClick={() => deletePage(p.id)}
                    className="text-xs text-rose-600 hover:text-rose-700"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(null)}
                    className="text-xs text-slate-500 hover:text-slate-700"
                  >
                    No
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onRetakePage(i)}
                    className="text-xs text-brand-700 hover:text-brand-800"
                    aria-label={`Retake page ${i + 1}`}
                  >
                    Retake
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(p.id)}
                    className="text-xs text-slate-500 hover:text-rose-600"
                    aria-label={`Delete page ${i + 1}`}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary" onClick={onAddMore}>
          + Add a page
        </button>
        <button
          type="button"
          className={clsx('btn-primary', pages.length === 0 && 'opacity-50')}
          onClick={() => void submit()}
          disabled={pages.length === 0}
        >
          Use these {pages.length} page{pages.length === 1 ? '' : 's'}
        </button>
        <button
          type="button"
          className="text-xs text-slate-500 hover:text-rose-600 ml-auto"
          onClick={() => {
            if (pages.length === 0) {
              void discardConfirmed();
              return;
            }
            setConfirmDiscard(true);
          }}
        >
          Cancel scan
        </button>
      </div>

      {confirmDiscard && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="scan-discard-title"
          className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4"
        >
          <div className="bg-white rounded-lg shadow max-w-sm w-full p-5 space-y-3">
            <h3 id="scan-discard-title" className="font-semibold text-slate-900">
              Discard {pages.length} page{pages.length === 1 ? '' : 's'}?
            </h3>
            <p className="text-sm text-slate-600">
              You&apos;ll lose every page you&apos;ve scanned so far. You can still upload regular
              files instead.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConfirmDiscard(false)}
              >
                Keep scanning
              </button>
              <button
                type="button"
                className="btn-primary bg-rose-600 hover:bg-rose-700"
                onClick={() => void discardConfirmed()}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render a 96×96 thumbnail data URL from the captured blob. Used for the
 * page-list rendering — full-resolution blobs in <img src=blob:url> work
 * but a small JPEG keeps memory + redraws cheap when the user reorders.
 */
async function makeThumbnail(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  let usedAsResult = false;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = (e) => reject(e);
      el.src = objectUrl;
    });
    const targetMax = 192; // 2× of 96 for retina sharpness
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    const k = long > targetMax ? targetMax / long : 1;
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      usedAsResult = true;
      return objectUrl;
    }
    ctx.drawImage(img, 0, 0, w, h);
    // Data URL is self-contained; revoke the object URL immediately so
    // the browser releases its mapping. Without this, an N-page batch
    // leaks N object URLs into the page's URL store — meaningful on
    // iOS Safari where the heap ceiling sits around 250 MB.
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    // Decode failed — fall back to the raw blob URL so the page still
    // renders. The URL must stay valid for the life of the page, so
    // mark it as "used as result" to skip the revoke in `finally`.
    usedAsResult = true;
    return objectUrl;
  } finally {
    if (!usedAsResult) URL.revokeObjectURL(objectUrl);
  }
}
