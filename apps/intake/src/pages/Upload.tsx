import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import * as tus from 'tus-js-client';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CameraModal, canUseCamera } from '../components/CameraModal.js';
import { ScanBatch } from '../components/ScanBatch.js';
import { url } from '../lib/boot.js';

/**
 * Phase 28.5 — anonymous intake upload page.
 *
 * Walk-up flow:
 *   1. Pull the upload token + sessionId from sessionStorage (set by 28.4
 *      IntakeForm). If missing or expired, send the user back to the
 *      staff-grid landing — they need a fresh session.
 *   2. File picker → one tus upload per file. Each file gets a per-row
 *      progress bar; aggregate "X files · Y MB / Z MB" shown at top.
 *   3. Finalize button POSTs /sessions/:id/finalize. On 200 navigate to
 *      the success page.
 *
 * What's NOT here (deferred):
 *   - Drag-and-drop styling polish (Phase 28.17 polish — basic file
 *     picker is what the build plan acceptance criterion calls for).
 *   - In-browser image preview / thumbnail (deferred).
 *   - Scan-document camera flow (Phase 28.6).
 */

interface StoredToken {
  uploadToken: string;
  expiresAt: string;
}

interface UploadRow {
  id: string;
  file: File;
  bytesSent: number;
  bytesTotal: number;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
  cancel?: () => void;
  /** Optional extra tus metadata. Defaults: kind='file', orderIndex=0. */
  extraMeta?: {
    kind?: 'file' | 'scanned_image';
    orderIndex?: number;
  };
}

// Per-file cap (50 MB default; firm setting can raise this).
const PER_FILE_CAP_BYTES = 250 * 1024 * 1024;

export function Upload(): JSX.Element {
  const params = useParams<{ staffId: string }>();
  const staffId = params.staffId ?? '';
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('s') ?? '';
  const navigate = useNavigate();

  // Pull the token stashed by IntakeForm. If absent / expired, bounce back
  // to the staff grid so the user creates a new session.
  const [token, setToken] = useState<string | null>(null);
  const [tokenChecked, setTokenChecked] = useState(false);
  useEffect(() => {
    if (!sessionId) {
      navigate('/intake', { replace: true });
      return;
    }
    const raw = sessionStorage.getItem(`vibe-intake-token:${sessionId}`);
    if (!raw) {
      navigate(`/intake/${staffId}`, { replace: true });
      return;
    }
    try {
      const parsed = JSON.parse(raw) as StoredToken;
      if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
        sessionStorage.removeItem(`vibe-intake-token:${sessionId}`);
        navigate(`/intake/${staffId}`, { replace: true });
        return;
      }
      setToken(parsed.uploadToken);
    } catch {
      navigate(`/intake/${staffId}`, { replace: true });
      return;
    }
    setTokenChecked(true);
  }, [sessionId, staffId, navigate]);

  const [rows, setRows] = useState<UploadRow[]>([]);
  const [finalizing, setFinalizing] = useState(false);
  const [finalError, setFinalError] = useState<string | null>(null);
  // Phase 28.6 — camera-capture modal. Only opened when `canUseCamera()`
  // reports getUserMedia is reachable; in-app browsers / older iOS fall
  // back to the native <input capture> path which is the camera-fallback
  // hidden file input below.
  const [cameraOpen, setCameraOpen] = useState(false);
  // Phase 28.7 review step removed in v0.4.29 — see commit log. The
  // in-browser cropping UI required OpenCV.js (~7 MB WASM) which had a
  // race in its init that hung iOS Safari at "Loading…". Captures now
  // go straight from CameraModal to upload/batch; the server does any
  // edge-detection / warp during PDF assembly.
  // Phase 28.8 — multi-page scan batch. Once the user enters scan mode
  // (clicks "Scan a document"), pages accumulate in ScanBatch until they
  // hit "Use these N pages" → all pages enqueue at once with
  // kind='scanned_image' + orderIndex matching the review-confirmed order.
  const [batchActive, setBatchActive] = useState(false);
  const [retakeIndex, setRetakeIndex] = useState<number | null>(null);
  // Pending capture handed off to ScanBatch via prop rather than an
  // imperative ref. With the prior `batchRef.current?.addPage(file)`
  // pattern, an iOS Safari capture flow could land at onScannerConfirm
  // before the child component's ref-setup useEffect had committed —
  // the optional-chain silently swallowed the file and the user
  // arrived at an empty ScanBatch with no error. A useEffect-watched
  // state field is reliably consumed once the child mounts, regardless
  // of effect ordering.
  const [pendingBatchPage, setPendingBatchPage] = useState<{
    file: File;
    replaceIndex: number | null;
    /** Bumped on every queue so identical files (same File ref) still
     *  trigger the consume effect. */
    seq: number;
  } | null>(null);
  const pendingSeq = useRef(0);
  const idCounter = useRef(0);
  const cameraFallbackRef = useRef<HTMLInputElement | null>(null);
  const scanCounterRef = useRef(0);

  // Shared file-enqueue path used by both the hidden <input type=file>
  // change handler and the new drag-and-drop dropzone. Splitting it out
  // keeps the size-cap rule + status seeding in one place — previously
  // duplicated between the file picker and the scan / camera fallbacks.
  function enqueueFiles(list: FileList | File[]): void {
    if (!list || !token) return;
    const arr = list instanceof Array ? list : Array.from(list);
    if (arr.length === 0) return;
    const next: UploadRow[] = [];
    for (const f of arr) {
      if (f.size > PER_FILE_CAP_BYTES) {
        next.push({
          id: String(++idCounter.current),
          file: f,
          bytesSent: 0,
          bytesTotal: f.size,
          status: 'error',
          error: 'Too large — max 250 MB per file.',
        });
        continue;
      }
      const row: UploadRow = {
        id: String(++idCounter.current),
        file: f,
        bytesSent: 0,
        bytesTotal: f.size,
        status: 'queued',
      };
      next.push(row);
    }
    setRows((prev) => [...prev, ...next]);
    for (const r of next) {
      if (r.status === 'queued') startUpload(r);
    }
  }

  function patchRow(id: string, patch: Partial<UploadRow>): void {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function startUpload(row: UploadRow): void {
    if (!token) return;
    patchRow(row.id, { status: 'uploading' });
    const metadata: Record<string, string> = {
      filename: row.file.name,
      filetype: row.file.type || 'application/octet-stream',
    };
    // Phase 28.8 — multi-page scan batches carry kind + orderIndex so the
    // server-side `intake_files` row gets the right kind (the 28.9 PDF
    // conversion job assembles `kind='scanned_image'` rows ordered by
    // `order_index`).
    if (row.extraMeta?.kind) metadata.kind = row.extraMeta.kind;
    if (row.extraMeta?.orderIndex !== undefined) {
      metadata.orderIndex = String(row.extraMeta.orderIndex);
    }
    const upload = new tus.Upload(row.file, {
      endpoint: url('/api/public/intake/uploads'),
      retryDelays: [0, 1000, 3000, 5000],
      // The intake bytes are plaintext-over-TLS (ADR-028) — server encrypts
      // at rest. tus-js-client doesn't expose `withCredentials` in its
      // public typings but defaults to false; the upload token in the
      // header is the only auth so cookies riding along would be ignored
      // anyway. (Server side has `credentials: 'omit'` on the SPA fetches.)
      headers: {
        Authorization: `Bearer ${token}`,
      },
      metadata,
      chunkSize: 5 * 1024 * 1024, // 5 MB chunks — balances resumability with HTTP overhead.
      onError: (err) => {
        patchRow(row.id, { status: 'error', error: String(err).slice(0, 200) });
      },
      onProgress: (sent, total) => {
        patchRow(row.id, { bytesSent: sent, bytesTotal: total });
      },
      onSuccess: () => {
        patchRow(row.id, { status: 'done', bytesSent: row.bytesTotal });
      },
    });
    patchRow(row.id, { cancel: () => upload.abort() });
    upload.start();
  }

  function removeRow(id: string): void {
    setRows((prev) => {
      const r = prev.find((x) => x.id === id);
      r?.cancel?.();
      return prev.filter((x) => x.id !== id);
    });
  }

  /**
   * Wrap a captured camera Blob in a real File so the existing tus
   * pipeline doesn't need a separate code path. Filename pattern matches
   * the staff-facing display: `scan-001.jpg`, `scan-002.jpg`, … keyed by
   * a per-session ref counter (doesn't survive page reloads, which is
   * fine — tus rows already have unique server-side names).
   */
  function blobToScanFile(blob: Blob): File {
    scanCounterRef.current += 1;
    const n = String(scanCounterRef.current).padStart(3, '0');
    return new File([blob], `scan-${n}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });
  }

  /**
   * Push a captured/picked image into the upload queue with
   * `kind=scanned_image` so the server-side PDF assembly ticker picks
   * it up. Used by both the in-page CameraModal and the
   * &lt;input capture&gt; fallback. As of v0.4.29 the client no longer
   * pre-cuts a quad — server runs edge detection during conversion
   * (`intakeScannerWarp.ts`), falling back to a no-crop full-image
   * page if the detector can't find a confident quadrilateral.
   */
  function enqueueScan(file: File): void {
    if (!token) return;
    if (file.size > PER_FILE_CAP_BYTES) {
      setRows((prev) => [
        ...prev,
        {
          id: String(++idCounter.current),
          file,
          bytesSent: 0,
          bytesTotal: file.size,
          status: 'error',
          error: 'Too large — max 250 MB per file.',
        },
      ]);
      return;
    }
    const row: UploadRow = {
      id: String(++idCounter.current),
      file,
      bytesSent: 0,
      bytesTotal: file.size,
      status: 'queued',
      extraMeta: { kind: 'scanned_image' },
    };
    setRows((prev) => [...prev, row]);
    startUpload(row);
  }

  function onCameraCapture(blob: Blob): void {
    // v0.4.29 — no more client-side review/crop step. The blob goes
    // straight to upload (or the multi-page batch if scan mode is
    // active). Server-side edge detection + warp + enhance happens
    // during PDF assembly. See intakeScannerWarp.ts.
    setCameraOpen(false);
    const file = blobToScanFile(blob);
    if (!batchActive) {
      enqueueScan(file);
      return;
    }
    pendingSeq.current += 1;
    setPendingBatchPage({
      file,
      replaceIndex: retakeIndex,
      seq: pendingSeq.current,
    });
    if (retakeIndex !== null) setRetakeIndex(null);
  }

  function onBatchAddMore(): void {
    setRetakeIndex(null);
    setCameraOpen(true);
  }

  function onBatchRetake(index: number): void {
    setRetakeIndex(index);
    setCameraOpen(true);
  }

  function onBatchSubmit(pages: Array<{ file: File }>): void {
    // Convert the batched pages into upload rows with kind=scanned_image
    // and orderIndex matching their position in the review-confirmed
    // order. Each page is one tus upload — the 28.9 conversion job
    // re-assembles them into a single PDF on the server, running
    // edge-detection per page (intakeScannerWarp.ts) along the way.
    setBatchActive(false);
    for (let i = 0; i < pages.length; i++) {
      const { file: f } = pages[i]!;
      if (f.size > PER_FILE_CAP_BYTES) {
        setRows((prev) => [
          ...prev,
          {
            id: String(++idCounter.current),
            file: f,
            bytesSent: 0,
            bytesTotal: f.size,
            status: 'error',
            error: 'Too large — max 250 MB per file.',
          },
        ]);
        continue;
      }
      const row: UploadRow = {
        id: String(++idCounter.current),
        file: f,
        bytesSent: 0,
        bytesTotal: f.size,
        status: 'queued',
        extraMeta: {
          kind: 'scanned_image',
          orderIndex: i,
        },
      };
      setRows((prev) => [...prev, row]);
      startUpload(row);
    }
  }

  function onBatchDiscard(): void {
    setBatchActive(false);
    setRetakeIndex(null);
  }

  async function onCameraFallback(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const list = e.target.files;
    if (!list) return;
    for (const f of Array.from(list)) {
      // Native &lt;input capture&gt; returns a File with a manufacturer-
      // chosen name (e.g. "image.jpg"). Rename to the staff-facing
      // scan-001.jpg pattern so the admin view stays tidy.
      const renamed = new File([f], blobToScanFile(f).name, {
        type: f.type || 'image/jpeg',
      });
      if (batchActive) {
        // 28.8 — append to the multi-page batch instead of uploading
        // immediately. The fallback path skips ScannerReview because
        // the OS camera already produces a final photo; the user can
        // still reorder / delete / retake from ScanBatch. Use the same
        // state-based handoff as the in-browser camera path so a
        // mount-race can't swallow the capture.
        pendingSeq.current += 1;
        setPendingBatchPage({ file: renamed, replaceIndex: null, seq: pendingSeq.current });
      } else {
        enqueueScan(renamed);
      }
    }
    e.target.value = '';
  }

  function openScan(): void {
    // Entering scan mode: subsequent captures land in the multi-page
    // batch instead of going straight to upload. ScanBatch handles its
    // own IDB-backed hydration on mount so a previously-saved batch for
    // this sessionId returns automatically.
    setBatchActive(true);
    if (canUseCamera()) {
      setCameraOpen(true);
    } else {
      // Fall back to the platform file picker with capture=environment;
      // iOS Safari + Android Chrome render that as a "Take Photo" option.
      cameraFallbackRef.current?.click();
    }
  }

  const totalBytes = rows.reduce((s, r) => s + r.bytesTotal, 0);
  const sentBytes = rows.reduce((s, r) => s + r.bytesSent, 0);
  const allDone = rows.length > 0 && rows.every((r) => r.status === 'done');
  const anyUploading = rows.some((r) => r.status === 'uploading' || r.status === 'queued');
  const canFinalize = allDone && !finalizing;

  async function finalize(): Promise<void> {
    if (!token || !sessionId) return;
    setFinalizing(true);
    setFinalError(null);
    try {
      const res = await fetch(url(`/api/public/intake/sessions/${sessionId}/finalize`), {
        method: 'POST',
        credentials: 'omit',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`finalize_${res.status}: ${body}`);
      }
      // Session token is single-use after finalize; drop it.
      sessionStorage.removeItem(`vibe-intake-token:${sessionId}`);
      const data = (await res.json()) as { successUrl?: string; fileCount: number };
      navigate(`/intake/${staffId}/done?s=${sessionId}&n=${data.fileCount}`, { replace: true });
    } catch (err) {
      setFinalError(String(err).slice(0, 200));
    } finally {
      setFinalizing(false);
    }
  }

  if (!tokenChecked) {
    return <div className="p-4 text-sm text-slate-500">Loading…</div>;
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-2xl px-4 py-6">
          <h1 className="text-lg font-semibold text-slate-900">Send your files</h1>
          <p className="text-sm text-slate-600">
            Add one or more files. We&apos;ll encrypt them at rest and confirm receipt.
          </p>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-2xl w-full px-4 py-6 space-y-4">
        {/* Hidden &lt;input capture&gt; fallback — always mounted so the camera
            entry-point can trigger it on devices without getUserMedia. */}
        <input
          ref={cameraFallbackRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={(e) => void onCameraFallback(e)}
          aria-hidden="true"
          tabIndex={-1}
        />

        {batchActive ? (
          <ScanBatch
            sessionId={sessionId}
            pendingPage={pendingBatchPage}
            onPendingConsumed={() => setPendingBatchPage(null)}
            onAddMore={onBatchAddMore}
            onRetakePage={onBatchRetake}
            onSubmit={onBatchSubmit}
            onDiscard={onBatchDiscard}
          />
        ) : (
          <>
            {/* Phase 28.6 — Scan-a-document entry point. Prominent (full
                width, primary) on mobile, secondary on desktop. */}
            <button
              type="button"
              onClick={openScan}
              className="w-full sm:hidden btn-primary"
              aria-label="Scan a document with the camera"
            >
              📷 Scan a document
            </button>

            <Dropzone onFiles={enqueueFiles} onScan={openScan} />
            <p className="text-xs text-slate-500 text-center">
              PDF, image, Word, Excel, CSV, or plain text — up to 250 MB each.
            </p>
          </>
        )}

        {rows.length > 0 && (
          <div className="bg-white rounded-md border border-slate-200">
            <div className="flex items-center justify-between px-4 py-2 text-xs text-slate-600 border-b border-slate-100">
              <span>
                {rows.length} file{rows.length === 1 ? '' : 's'}
              </span>
              <span>
                {formatBytes(sentBytes)} / {formatBytes(totalBytes)}
              </span>
            </div>
            <ul role="list" className="divide-y divide-slate-100">
              {rows.map((r) => (
                <li key={r.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-slate-900 truncate">{r.file.name}</div>
                      <div className="text-xs text-slate-500">{formatBytes(r.bytesTotal)}</div>
                    </div>
                    <StatusPill row={r} />
                    {r.status !== 'done' && (
                      <button
                        type="button"
                        onClick={() => removeRow(r.id)}
                        className="text-xs text-slate-500 hover:text-rose-600"
                        aria-label={`Remove ${r.file.name}`}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  {(r.status === 'uploading' || r.status === 'queued') && (
                    <div className="mt-2 h-1.5 bg-slate-100 rounded overflow-hidden">
                      <div
                        className="h-full bg-brand-600 transition-[width] duration-200"
                        style={{
                          width: `${r.bytesTotal ? Math.round((r.bytesSent / r.bytesTotal) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  )}
                  {r.error && <div className="mt-1 text-xs text-rose-600">{r.error}</div>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {finalError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 text-rose-900 text-sm p-3">
            {finalError}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button type="button" className="btn-primary" disabled={!canFinalize} onClick={finalize}>
            {finalizing
              ? 'Finishing…'
              : anyUploading
                ? 'Waiting for uploads…'
                : rows.length === 0
                  ? 'Add files first'
                  : 'Send to staff'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => navigate(`/intake/${staffId}`)}
            disabled={finalizing}
          >
            Back
          </button>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-2xl px-4 py-6 text-xs text-slate-500">
          <p>
            Files uploaded here are encrypted at rest. By proceeding you confirm the documents are
            yours to share. This page does not create an account.
          </p>
        </div>
      </footer>

      {cameraOpen && (
        <CameraModal onCapture={onCameraCapture} onClose={() => setCameraOpen(false)} />
      )}
    </div>
  );
}

function StatusPill({ row }: { row: UploadRow }): JSX.Element {
  const cls = {
    queued: 'bg-slate-100 text-slate-600',
    uploading: 'bg-blue-100 text-blue-800',
    done: 'bg-emerald-100 text-emerald-800',
    error: 'bg-rose-100 text-rose-800',
  }[row.status];
  const label = {
    queued: 'queued',
    uploading: `${Math.round((row.bytesSent / Math.max(row.bytesTotal, 1)) * 100)}%`,
    done: 'done',
    error: 'failed',
  }[row.status];
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{label}</span>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Modern drag-and-drop dropzone used by the intake Upload page. The
// whole box is a click target that opens the native file picker, AND it
// listens for HTML5 drag events at the document layer so a user can
// drop files anywhere over the panel. The dragover prevent-default is
// load-bearing — without it, browsers refuse the drop and re-navigate
// to the file as if the URL bar were the target.
function Dropzone({
  onFiles,
  onScan,
}: {
  onFiles: (files: FileList | File[]) => void;
  onScan: () => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  // Counter pattern: dragenter/dragleave fire for every nested element
  // we cross, so a single boolean would flicker as the cursor moves over
  // child nodes. The counter only flips false when balance returns to 0.
  const depth = useRef(0);

  function onDragEnter(e: React.DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    depth.current += 1;
    setOver(true);
  }
  function onDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(e: React.DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    onFiles(e.dataTransfer.files);
  }

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label="Drop files here or click to choose"
      className={
        'relative rounded-xl border-2 border-dashed bg-white p-8 text-center cursor-pointer transition-colors ' +
        (over
          ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-200'
          : 'border-slate-300 hover:border-brand-400 hover:bg-slate-50')
      }
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={(e) => {
          onFiles(e.target.files ?? []);
          e.target.value = '';
        }}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />

      {/* Cloud-upload glyph. SVG inline so the bundle stays free of an
          icon-library dep and the colour follows currentColor for the
          drag-over highlight. */}
      <svg
        viewBox="0 0 48 48"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={'mx-auto h-12 w-12 mb-3 ' + (over ? 'text-brand-600' : 'text-slate-400')}
      >
        <path d="M14 30a8 8 0 0 1 1.6-15.8 12 12 0 0 1 23.3 4.4A7 7 0 0 1 38 32H16a2 2 0 0 1-2-2z" />
        <path d="M24 22v14m-5-9 5-5 5 5" />
      </svg>
      <div className={'font-medium ' + (over ? 'text-brand-700' : 'text-slate-800')}>
        {over ? 'Drop to upload' : 'Drag files here, or click to choose'}
      </div>
      <div className="mt-1 text-xs text-slate-500">
        Files upload as soon as you add them — you can keep adding while we work.
      </div>
      {/* Secondary scan button (desktop only — mobile gets the bigger
          green button above the dropzone). stopPropagation so clicking
          this doesn't ALSO open the file picker. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onScan();
        }}
        className="hidden sm:inline-flex mt-4 items-center gap-1 text-xs text-brand-700 hover:text-brand-900 hover:underline"
        aria-label="Scan a document with the camera instead"
      >
        📷 Scan a document instead
      </button>
    </div>
  );
}

export function Done(): JSX.Element {
  const params = useParams<{ staffId: string }>();
  const [searchParams] = useSearchParams();
  const n = Number(searchParams.get('n') ?? '0');
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded shadow-card p-6 space-y-3 text-center">
        <h1 className="text-lg font-semibold text-slate-900">
          Thanks — we got your file{n === 1 ? '' : 's'}.
        </h1>
        <p className="text-sm text-slate-600">
          We sent a confirmation to the contact you provided. You can close this tab.
        </p>
        <p className="text-xs text-slate-400">
          Staff recipient: <code>{params.staffId}</code>
        </p>
      </div>
    </div>
  );
}
