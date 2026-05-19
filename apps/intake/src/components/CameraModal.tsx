import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

/**
 * Phase 28.6 — full-screen camera capture modal for the intake SPA.
 *
 * Wraps `navigator.mediaDevices.getUserMedia` with a UX that handles every
 * realistic failure mode walk-up CPA-firm clients hit:
 *   - getUserMedia missing entirely (in-app browsers like Instagram /
 *     Facebook, older iOS): the parent component falls back to the native
 *     <input capture> path BEFORE this component renders — see `canUseCamera`.
 *   - Permission denied / dismissed: render a help block with the
 *     platform-specific re-enable hint and a "Use file picker instead"
 *     button that closes the modal.
 *   - Stream-acquisition errors that aren't permission-related: same
 *     fallback path.
 *
 * Captured frame: video element → off-screen canvas at the stream's native
 * resolution → `canvas.toBlob('image/jpeg', 0.9)`. Phase 28.7 will add
 * jscanify-based corner detection + perspective correction; for 28.6 the
 * blob feeds the existing tus pipeline as a regular file upload.
 *
 * iOS quirks that drove the design:
 *   - iOS 16.4+ is the minimum for getUserMedia inside an installed PWA.
 *   - In-app browsers (Instagram, Facebook) block getUserMedia entirely —
 *     navigator.mediaDevices is often undefined or returns NotAllowedError
 *     immediately. Caller's `canUseCamera` feature-detect catches the
 *     first; this component's error handler catches the second.
 *   - Safari requires a user-gesture-initiated promise chain to call
 *     play() without autoplay-blocked errors. We call play() from inside
 *     the parent's click handler's downstream effect, which suffices.
 *
 * Battery/heat: stopping every track in cleanup is load-bearing — leaving
 * the camera on after the modal closes drains battery quickly on phones.
 */

export function canUseCamera(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!navigator.mediaDevices) return false;
  if (typeof navigator.mediaDevices.getUserMedia !== 'function') return false;
  return true;
}

export interface CameraModalProps {
  /** Called once per successful capture. Parent decides whether to close
   *  the modal (single-shot capture) or leave it open for multi-shot. */
  onCapture: (blob: Blob) => void;
  onClose: () => void;
}

// MediaTrackCapabilities is missing `torch` in the lib.dom types because
// it's a non-standard extension; we narrow with a local interface so
// reading the capability doesn't need an `any`.
interface TorchCapability {
  torch?: boolean;
}

export function CameraModal({ onCapture, onClose }: CameraModalProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // Acquire the stream once on mount. Cleanup stops every track — load-
  // bearing for battery/heat (a live camera left running after the modal
  // closes is the single biggest UX complaint on a CPA firm's older
  // Android fleet).
  useEffect(() => {
    let cancelled = false;
    async function start(): Promise<void> {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            // `ideal: 1920` lets phones with 4K-capable sensors return a
            // 4K stream — the resulting frame chews ~64 MB ImageData
            // per warp and tips iOS Safari over its ~250 MB heap. `max`
            // caps the stream so the rest of the pipeline stays inside
            // its memory budget. 1920×1080 is plenty for document OCR.
            width: { ideal: 1920, max: 1920 },
            height: { ideal: 1080, max: 1080 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const videoTrack = stream.getVideoTracks()[0];
        // Torch capability check. Not every device + browser exposes it
        // (iOS Safari currently does not); the toggle button only renders
        // when it's actually available.
        const caps = videoTrack?.getCapabilities?.() as MediaTrackCapabilities & TorchCapability;
        if (caps?.torch) setHasTorch(true);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          try {
            await videoRef.current.play();
          } catch (err) {
            // Autoplay-blocked or similar — surface as a generic message,
            // user can hit "use file picker" instead.
            if (!cancelled) setError(formatError(err));
          }
        }
      } catch (err) {
        if (!cancelled) setError(formatError(err));
      }
    }
    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  // Esc closes; intercept at window level so it works regardless of
  // focus position inside the modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const capture = useCallback(async (): Promise<void> => {
    const video = videoRef.current;
    if (!video) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w === 0 || h === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9);
    });
    if (blob) onCapture(blob);
  }, [onCapture]);

  const toggleTorch = useCallback(async (): Promise<void> => {
    const stream = streamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    try {
      // `torch` is a non-standard advanced constraint; TS doesn't model it
      // on MediaTrackConstraintSet so we narrow + cast intentionally.
      await track.applyConstraints({
        advanced: [{ torch: !torchOn } as unknown as MediaTrackConstraintSet],
      });
      setTorchOn((v) => !v);
    } catch {
      // Some devices report torch capability but reject the constraint
      // (manufacturer quirk). Surface a hint instead of hard-failing.
      setHasTorch(false);
    }
  }, [torchOn]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="camera-modal-title"
      className="fixed inset-0 z-50 bg-black text-white flex flex-col"
    >
      <h2 id="camera-modal-title" className="sr-only">
        Scan a document
      </h2>

      {/* Top bar — close button + optional torch toggle. */}
      <div className="flex items-center justify-between p-3">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          aria-label="Cancel and close the camera"
        >
          Cancel
        </button>
        {hasTorch && (
          <button
            type="button"
            onClick={toggleTorch}
            aria-pressed={torchOn}
            className={clsx(
              'px-3 py-2 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-white',
              torchOn ? 'bg-yellow-300 text-black' : 'bg-white/10 hover:bg-white/20',
            )}
            aria-label={torchOn ? 'Turn flashlight off' : 'Turn flashlight on'}
          >
            {torchOn ? 'Light on' : 'Light'}
          </button>
        )}
      </div>

      {/* Video / error region. flex-1 fills the middle, the video stays
          centred. */}
      <div className="flex-1 flex items-center justify-center overflow-hidden">
        {error ? (
          <div className="max-w-md mx-auto p-6 text-center space-y-4">
            <p className="text-sm">We couldn&apos;t open the camera.</p>
            <p className="text-xs text-slate-300">{error}</p>
            <p className="text-xs text-slate-300">
              Most browsers ask for camera permission on first use. If you previously denied it,
              open the site settings (lock icon in the address bar) and re-enable camera, then try
              again. You can also use the file picker instead — it lets you take a photo with your
              phone&apos;s camera app and attach it the same way.
            </p>
            <button type="button" onClick={onClose} className="btn-primary">
              Use file picker instead
            </button>
          </div>
        ) : (
          <video
            ref={videoRef}
            // playsInline is the iOS-specific knob that keeps the preview
            // inside the modal instead of jumping to full-screen video.
            playsInline
            muted
            // CSS handles letterboxing — the video element is allowed to
            // grow to the container's intrinsic aspect ratio.
            className="max-h-full max-w-full"
          />
        )}
      </div>

      {/* Capture button. Big circular target — easy to hit on phones held
          in one hand. */}
      {!error && (
        <div className="flex items-center justify-center pb-8">
          <button
            type="button"
            onClick={capture}
            aria-label="Take photo"
            className="w-16 h-16 rounded-full border-4 border-white bg-white/0 hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <span className="block w-12 h-12 rounded-full bg-white mx-auto" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

function formatError(err: unknown): string {
  if (!err || typeof err !== 'object') return 'Unknown camera error.';
  const e = err as { name?: string; message?: string };
  // Map the standard MediaError names to walk-up-friendly copy.
  switch (e.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No rear-facing camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is in use by another app. Close other apps and try again.';
    case 'AbortError':
      return 'Camera start was interrupted.';
    default:
      return e.message ?? 'Unknown camera error.';
  }
}
