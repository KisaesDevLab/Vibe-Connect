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

export interface ScanBatchProps {
  sessionId: string;
  /** Called by the parent when the user wants to add a new page — the
   *  parent reopens the camera flow and eventually calls back to
   *  `ScanBatchRef.addPage` with the captured + cropped file. */
  onAddMore: () => void;
  /** Same idea but the parent should reopen the camera in "retake page N"
   *  mode; we pass the index that should be replaced when the new page
   *  comes back. */
  onRetakePage: (index: number) => void;
  /** User confirmed the batch — emit ordered File[] (page 1 first). The
   *  parent clears its review state and calls back into the upload pipe
   *  with kind='scanned_image' metadata. */
  onSubmit: (files: File[]) => void;
  /** User discarded the batch (after confirmation) — parent closes the
   *  batch view; the IDB record is already cleared. */
  onDiscard: () => void;
}

export interface ScanBatchHandle {
  /** Imperative add: the parent invokes this when the ScannerReview
   *  finishes confirming a page that should join the batch. */
  addPage: (file: File) => Promise<void>;
  /** Imperative replace: the parent invokes this when the parent had
   *  asked for a retake of page N and the user confirmed a new shot. */
  replacePage: (index: number, file: File) => Promise<void>;
}

export function ScanBatch({
  sessionId,
  onAddMore,
  onRetakePage,
  onSubmit,
  onDiscard,
  ref,
}: ScanBatchProps & { ref?: React.MutableRefObject<ScanBatchHandle | null> }): JSX.Element {
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

  const addPage = useCallback(async (file: File): Promise<void> => {
    const thumb = await makeThumbnail(file);
    setPages((prev) => [
      ...prev,
      {
        id: randomId(),
        blob: file,
        thumb,
        capturedAt: Date.now(),
      },
    ]);
  }, []);

  const replacePage = useCallback(
    async (index: number, file: File): Promise<void> => {
      const thumb = await makeThumbnail(file);
      setPages((prev) => {
        const next = prev.slice();
        if (index < 0 || index >= next.length) return prev;
        next[index] = {
          id: next[index]!.id,
          blob: file,
          thumb,
          capturedAt: Date.now(),
        };
        return next;
      });
    },
    [],
  );

  // Expose imperative handlers to the parent — useImperativeHandle would
  // be cleaner but requires forwardRef wrapping; passing a mutable ref
  // through props is the simpler pattern here.
  useEffect(() => {
    if (ref) ref.current = { addPage, replacePage };
    return () => {
      if (ref) ref.current = null;
    };
  }, [ref, addPage, replacePage]);

  function deletePage(id: string): void {
    setPages((prev) => prev.filter((p) => p.id !== id));
    setConfirmDeleteId(null);
  }

  const dragFromRef = useRef<number | null>(null);
  function onDragStart(index: number): void {
    dragFromRef.current = index;
  }
  function onDragOver(e: React.DragEvent): void {
    e.preventDefault();
  }
  function onDrop(targetIndex: number): void {
    const from = dragFromRef.current;
    dragFromRef.current = null;
    if (from === null || from === targetIndex) return;
    setPages((prev) => {
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      if (!moved) return prev;
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  async function submit(): Promise<void> {
    const files = pages.map((p, i) => {
      const idx = String(i + 1).padStart(3, '0');
      return new File([p.blob], `scan-page-${idx}.jpg`, {
        type: p.blob.type || 'image/jpeg',
        lastModified: p.capturedAt,
      });
    });
    await clearScanBatch(sessionId);
    onSubmit(files);
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
              draggable
              onDragStart={() => onDragStart(i)}
              onDragOver={onDragOver}
              onDrop={() => onDrop(i)}
              className="bg-white border border-slate-200 rounded-md p-3 flex items-center gap-3 cursor-move"
            >
              <span className="text-slate-400 select-none" aria-hidden="true">⋮⋮</span>
              <img
                src={p.thumb}
                alt={`Page ${i + 1} of ${pages.length}`}
                className="w-16 h-16 object-cover rounded border border-slate-200 bg-slate-50"
                draggable={false}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-900">Page {i + 1}</div>
                <div className="text-xs text-slate-500">
                  {formatBytes(p.blob.size)}
                </div>
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
    if (!ctx) return objectUrl;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    // If decoding fails, fall back to the raw blob URL — slightly heavier
    // but at least the page renders.
    return objectUrl;
  } finally {
    // We deliberately don't revoke the object URL inside the success path
    // because the thumbnail is a *data* URL — but the catch fallback IS
    // the object URL, and we'd want it to stay valid until the page is
    // removed. Cheap tradeoff: leak a few hundred bytes per page; the
    // browser releases them on tab close.
  }
}
