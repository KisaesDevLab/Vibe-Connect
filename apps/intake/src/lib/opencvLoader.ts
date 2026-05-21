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
    // Wait for the WASM runtime to be ready. Three correctness traps
    // we have to thread:
    //
    //   1. RACE: the prior version did `if (!cv.Mat) { await new
    //      Promise(r => cv.onRuntimeInitialized = () => r()) }`. On
    //      iOS Safari the WASM runtime frequently initialises BETWEEN
    //      the Mat check and the hook assignment — the OpenCV.js
    //      default `onRuntimeInitialized` (a no-op) has already fired
    //      and OUR replacement hook never runs. Promise never
    //      resolves; the ScannerReview "Loading…" screen hangs
    //      forever. This was the user-reported freeze "after taking
    //      the picture it freezes at loading" on iOS.
    //
    //      Fix: set the hook FIRST, then re-check Mat inside the
    //      promise body. If Mat exists by that point, the runtime is
    //      ready and we resolve directly. Otherwise the hook fires
    //      when the runtime finishes. Either branch terminates.
    //
    //   2. NO-HOOK BUILDS: a future opencv-js build might not expose
    //      onRuntimeInitialized at all. The Mat-poll fast path covers
    //      that — if Mat is already there, we never need the hook.
    //
    //   3. WEDGED INIT: even with the race fixed, some Safari versions
    //      have failed WASM compilations that leave the runtime in a
    //      half-initialised state where neither the hook fires nor
    //      Mat materialises. Backstop with a 10s timeout that rejects;
    //      scannerMath.tryAutoDetect catches and the user gets the
    //      default 8%-inset quad so manual corner-drag still works.
    const OPENCV_INIT_TIMEOUT_MS = 10_000;
    await new Promise<void>((resolve, reject) => {
      const cvMut = cv as { onRuntimeInitialized?: () => void; Mat?: unknown };
      const timer = setTimeout(
        () => reject(new Error(`opencv_init_timeout_after_${OPENCV_INIT_TIMEOUT_MS}ms`)),
        OPENCV_INIT_TIMEOUT_MS,
      );
      cvMut.onRuntimeInitialized = () => {
        clearTimeout(timer);
        resolve();
      };
      // Set the hook FIRST, then poll once. Mat being present here
      // means the runtime fired before us (or never needed to fire);
      // resolve immediately and don't wait for a hook that will
      // never re-fire.
      if (cvMut.Mat) {
        clearTimeout(timer);
        resolve();
      }
    });
    (window as unknown as { cv: unknown }).cv = cv;
    return cv;
  })().catch((err) => {
    loadPromise = null; // allow retry on a later call
    throw err;
  });
  return loadPromise;
}
