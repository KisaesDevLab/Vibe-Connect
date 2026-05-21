import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import clsx from 'clsx';
import {
  type EnhanceMode,
  type Point,
  type Quad,
  defaultQuad,
  tryAutoDetect,
} from './scannerMath.js';

/**
 * Phase 28.7 — review-and-crop screen between the camera capture (28.6)
 * and the upload pipeline (28.5).
 *
 * Flow:
 *   1. Receive the captured blob from CameraModal.
 *   2. Load into an <img>, render to a manageable preview size.
 *   3. Try `tryAutoDetect` (only runs if OpenCV.js is preloaded — see
 *      scannerMath.ts header for the rationale). Falls back to a default
 *      8%-inset quad otherwise.
 *   4. Render 4 draggable corner handles (≥44px touch targets) over the
 *      preview. Each handle's CSS position is in display-canvas pixels;
 *      we re-scale to natural-image pixels when serialising the quad for
 *      the server.
 *   5. Color / Grayscale (default) / B&W toggle.
 *   6. Confirm → wrap the ORIGINAL captured blob in a File + emit the
 *      quad in natural-image coords + the enhance mode. The conversion
 *      worker on the server performs the perspective warp and enhance
 *      during PDF assembly. Previously this step warped in-browser; on
 *      iOS Safari the ImageData stack OOMed for Pro-model camera
 *      sensors. Server-side moves the work off the device entirely.
 */

export interface ScannerConfirmation {
  /** The original captured photo, untouched. */
  file: File;
  /** Quad in NATURAL-image pixel coordinates (the upload payload). */
  quad: Quad;
  /** Natural-image dimensions, used by the server to sanity-check the
   *  quad against the file's actual decoded size. */
  sourceSize: { w: number; h: number };
  /** User's choice of enhancement; applied server-side. */
  enhanceMode: EnhanceMode;
}

export interface ScannerReviewProps {
  blob: Blob;
  onConfirm: (result: ScannerConfirmation) => void;
  onRetake: () => void;
  onCancel: () => void;
}

const DISPLAY_MAX = 800; // px on the long edge — keep DOM nodes light.
const HANDLE_PX = 44; // touch-target floor, per Apple HIG + WCAG.

export function ScannerReview({
  blob,
  onConfirm,
  onRetake,
  onCancel,
}: ScannerReviewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // Quad in DISPLAY-canvas coordinates (the user is dragging here).
  const [quad, setQuad] = useState<Quad | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number } | null>(null);
  const [mode, setMode] = useState<EnhanceMode>('grayscale');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the blob into an <img>, compute display size, run auto-detect.
  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = async () => {
      imgRef.current = img;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      setNaturalSize({ w, h });
      const long = Math.max(w, h);
      const k = long > DISPLAY_MAX ? DISPLAY_MAX / long : 1;
      const dw = Math.round(w * k);
      const dh = Math.round(h * k);
      setDisplaySize({ w: dw, h: dh });
      // Try auto-detect (returns null when OpenCV isn't on the page —
      // expected for the default appliance). Result is in natural coords;
      // scale down to display coords.
      const auto = await tryAutoDetect(img);
      if (auto) {
        setQuad(scaleQuad(auto, k));
      } else {
        setQuad(defaultQuad(dw, dh));
      }
    };
    img.onerror = () => setError('Could not read the captured image.');
    img.src = objectUrl;
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  function onCornerDrag(e: ReactPointerEvent<HTMLDivElement>, corner: keyof Quad): void {
    if (!containerRef.current || !displaySize) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const rect = containerRef.current.getBoundingClientRect();
    const move = (ev: PointerEvent): void => {
      const x = clamp(ev.clientX - rect.left, 0, displaySize.w);
      const y = clamp(ev.clientY - rect.top, 0, displaySize.h);
      setQuad((q) => (q ? { ...q, [corner]: { x, y } } : q));
    };
    const up = (ev: PointerEvent): void => {
      try {
        target.releasePointerCapture(ev.pointerId);
      } catch {
        /* swallow */
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function confirm(): void {
    if (!imgRef.current || !quad || !displaySize || !naturalSize) return;
    setProcessing(true);
    setError(null);
    try {
      // Scale display-quad back into natural-image coordinates and hand
      // the original blob + quad + mode off to the parent. The actual
      // perspective warp + enhance happens server-side during the PDF
      // conversion ticker (see services/intakeScannerWarp.ts). Keeping
      // the warp off the device fixes the iOS Safari OOM that the
      // 2400 px source clamp could only paper over.
      const k = naturalSize.w / displaySize.w;
      const nat: Quad = scaleQuad(quad, k);
      const stamp = String(Date.now()).slice(-6);
      // Preserve the original blob's MIME type so the server can decode
      // HEIC, PNG, etc. via sharp without sniffing from the extension.
      const type = blob.type || 'image/jpeg';
      const ext = mimeToExt(type);
      const file = new File([blob], `scan-${stamp}.${ext}`, {
        type,
        lastModified: Date.now(),
      });
      onConfirm({
        file,
        quad: nat,
        sourceSize: naturalSize,
        enhanceMode: mode,
      });
    } catch (err) {
      setError(formatErr(err));
      setProcessing(false);
    }
  }

  if (error) {
    return (
      <div className="fixed inset-0 z-50 bg-black text-white p-6 flex items-center justify-center">
        <div className="max-w-md text-center space-y-4">
          <p className="text-sm">{error}</p>
          <div className="flex gap-3 justify-center">
            <button type="button" onClick={onRetake} className="btn-secondary">
              Retake
            </button>
            <button type="button" onClick={onCancel} className="btn-secondary">
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="scanner-review-title"
      className="fixed inset-0 z-50 bg-black text-white flex flex-col"
    >
      <h2 id="scanner-review-title" className="sr-only">
        Adjust the scanned document
      </h2>

      {/* Top bar — retake / mode picker. */}
      <div className="flex items-center justify-between p-3 gap-2">
        <button
          type="button"
          onClick={onRetake}
          className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/20"
          aria-label="Retake the photo"
          disabled={processing}
        >
          Retake
        </button>
        <div role="radiogroup" aria-label="Image style" className="flex gap-1">
          {(['color', 'grayscale', 'bw'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              disabled={processing}
              className={clsx(
                'px-2 py-1 rounded text-xs',
                mode === m ? 'bg-white text-black' : 'bg-white/10 hover:bg-white/20',
              )}
            >
              {m === 'bw' ? 'B&W' : m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Preview region with draggable quad overlay. */}
      <div className="flex-1 flex items-center justify-center overflow-hidden p-2">
        {!displaySize || !quad ? (
          <div className="text-sm text-slate-300">Loading…</div>
        ) : (
          <div
            ref={containerRef}
            className="relative touch-none select-none"
            style={{ width: displaySize.w, height: displaySize.h }}
          >
            {/* Display the image scaled to displaySize. We re-paint via
                <img> rather than canvas so the GPU compositor handles
                resize — keeps the corner-drag thread responsive. */}
            <img
              src={imgRef.current?.src}
              alt="Captured page"
              draggable={false}
              className="absolute inset-0 w-full h-full pointer-events-none"
            />
            {/* Quad outline. SVG for crisp lines at any scale. */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              viewBox={`0 0 ${displaySize.w} ${displaySize.h}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <polygon
                points={[
                  `${quad.topLeft.x},${quad.topLeft.y}`,
                  `${quad.topRight.x},${quad.topRight.y}`,
                  `${quad.bottomRight.x},${quad.bottomRight.y}`,
                  `${quad.bottomLeft.x},${quad.bottomLeft.y}`,
                ].join(' ')}
                fill="rgba(46, 144, 250, 0.15)"
                stroke="rgba(46, 144, 250, 0.9)"
                strokeWidth={2}
              />
            </svg>
            {(['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const).map((c) => {
              const p = quad[c];
              return (
                <div
                  key={c}
                  onPointerDown={(e) => onCornerDrag(e, c)}
                  className="absolute rounded-full bg-white/90 border-2 border-brand-600 shadow"
                  style={{
                    left: p.x - HANDLE_PX / 2,
                    top: p.y - HANDLE_PX / 2,
                    width: HANDLE_PX,
                    height: HANDLE_PX,
                    touchAction: 'none',
                  }}
                  aria-label={`Drag ${humanCorner(c)} corner`}
                  role="slider"
                  aria-valuemin={0}
                  aria-valuemax={Math.max(displaySize.w, displaySize.h)}
                  aria-valuenow={Math.round(p.x + p.y)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom bar — confirm / cancel. */}
      <div className="flex items-center justify-between gap-3 p-3">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/20"
          aria-label="Cancel and discard this scan"
          disabled={processing}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirm}
          className="btn-primary"
          disabled={processing || !quad}
        >
          {processing ? 'Processing…' : 'Use this scan'}
        </button>
      </div>

      {processing && (
        <div
          className="absolute inset-0 bg-black/60 grid place-items-center"
          role="status"
          aria-live="polite"
        >
          <p className="text-sm">Cropping & enhancing…</p>
        </div>
      )}
    </div>
  );
}

function scaleQuad(q: Quad, k: number): Quad {
  return {
    topLeft: scalePoint(q.topLeft, k),
    topRight: scalePoint(q.topRight, k),
    bottomRight: scalePoint(q.bottomRight, k),
    bottomLeft: scalePoint(q.bottomLeft, k),
  };
}

function scalePoint(p: Point, k: number): Point {
  return { x: p.x * k, y: p.y * k };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function humanCorner(c: keyof Quad): string {
  return c
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .trim();
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

function formatErr(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return 'Could not process the scan.';
}
