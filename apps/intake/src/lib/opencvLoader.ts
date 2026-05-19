// Phase 28.17 — lazy loader for OpenCV.js so the intake bundle stays light
// for visitors who never open the scanner.
//
// @techstark/opencv-js wraps the official OpenCV.js build and exposes the
// same `cv` namespace. Vite code-splits the dynamic import into its own
// chunk — initial /intake landing stays small; the ~7 MB OpenCV chunk is
// only fetched when the user actually takes a photo and the ScannerReview
// asks for auto-detect.
//
// jscanify (used by scannerMath.tryAutoDetect) accesses `window.cv`
// directly, so this loader assigns it after the dynamic import resolves.
// One in-flight promise is cached so concurrent calls share the same load.

let loadPromise: Promise<unknown> | null = null;

/**
 * Resolve once OpenCV.js is loaded and its WASM runtime is ready.
 * Returns the cv namespace (also exposed as window.cv as a side effect
 * so jscanify can find it).
 */
export async function ensureOpenCV(): Promise<unknown> {
  if (typeof window === 'undefined') {
    throw new Error('ensureOpenCV: window unavailable');
  }
  // Already loaded (script tag, prior call, or hand-vendored). Trust it.
  const w = window as unknown as { cv?: unknown };
  if (w.cv) return w.cv;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    // The package ships a UMD build whose .d.ts is loose; cast through
    // unknown to extract the default export's `cv` namespace.
    const mod = (await import('@techstark/opencv-js')) as unknown;
    const cv = (mod as { default?: unknown }).default ?? mod;
    // The package returns once the WASM runtime is initialised, but some
    // builds resolve before `Mat`/`imread` are wired up. Wait for the
    // runtime-initialised flag if it's exposed; otherwise trust the
    // import promise. Either way, set window.cv so jscanify can find it.
    const maybeReady = (cv as { onRuntimeInitialized?: unknown }).onRuntimeInitialized;
    if (typeof maybeReady === 'function') {
      // Some builds expose `onRuntimeInitialized` as a settable hook
      // rather than a Promise. If it's already-initialised (Mat exists),
      // skip the wait.
      if (!(cv as { Mat?: unknown }).Mat) {
        await new Promise<void>((resolve) => {
          (cv as { onRuntimeInitialized: () => void }).onRuntimeInitialized = () => resolve();
        });
      }
    }
    (window as unknown as { cv: unknown }).cv = cv;
    return cv;
  })().catch((err) => {
    loadPromise = null; // allow retry on a later call
    throw err;
  });
  return loadPromise;
}
