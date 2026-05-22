// Phase 28 follow-up — server-side perspective warp + enhance for scanned
// intake images.
//
// Background: the original in-browser warp (apps/intake/src/components/
// scannerMath.ts `warpPerspective`) held the entire source-image
// ImageData, a downsampled scratch ImageData, and the output ImageData
// simultaneously. On iOS Safari (~250 MB JS heap) this OOMs silently for
// Pro-model camera sensors — the user lands on an empty ScanBatch with
// no surfaced error. Even with the 2400 px SOURCE_MAX clamp the margin
// is too thin.
//
// This module is the Node-side replacement: client uploads the raw
// camera JPEG, attaches the quad + enhance mode as tus metadata, server
// performs the warp here during the PDF-conversion job. Node's V8 heap
// defaults to ~4 GB, so the same algorithm runs without memory
// pressure — and we get to delete the in-browser warp entirely once the
// rollout completes.
//
// Algorithm: identical math as scannerMath.ts (homography via 8-unknown
// Gaussian elimination + per-pixel inverse-map bilinear sampler). The
// only differences are:
//   - Source pixels are pulled from sharp().raw() instead of canvas
//     `getImageData`.
//   - Output is fed back to sharp() for JPEG encoding instead of
//     `canvas.toBlob`.
//   - Adaptive-threshold "bw" enhance uses the same summed-area-table
//     mean filter as the client, just ported.
//
// Performance budget: 2000×2828 (A4 portrait at ~169 DPI) takes
// ~600-900 ms in Node on an appliance-class CPU (Xeon Bronze). The
// conversion ticker already runs out-of-band of the HTTP request lifecycle
// so this is wall-clock for the worker, not user-visible latency.
import sharp from 'sharp';

export interface Point {
  x: number;
  y: number;
}

export interface Quad {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

export type EnhanceMode = 'color' | 'grayscale' | 'bw';

export interface ScannerMeta {
  quad: Quad;
  enhanceMode: EnhanceMode;
  sourceSize: { w: number; h: number };
}

// Output cap on the long edge — matches OUTPUT_MAX in scannerMath.ts so
// the PDF assembler sees the same image dimensions whether the warp ran
// client-side (legacy) or server-side (current).
const OUTPUT_MAX = 2000;

// Working-size cap for server-side document edge detection. 800 px on
// the long edge keeps the BFS connected-component pass well under
// 1 second on appliance-class CPUs while preserving corner positions
// to within a few full-resolution pixels (the warp's bilinear sampler
// smooths over that).
const DETECT_WORK_EDGE = 800;

// Minimum fraction of the working image area the "document" component
// must occupy before we trust the detection. Phones in normal framing
// put the document at 50-90% of the frame; the 0.25 floor rejects
// "user took a picture of their desk with no paper" without rejecting
// legitimate phone-held-far scans.
const DETECT_MIN_AREA_FRACTION = 0.25;

/**
 * Type-guard a JSONB blob read from `intake_files.scanner_meta`. Returns
 * `null` if any field is missing or malformed — caller falls back to the
 * legacy "no warp, just EXIF rotate" path. Throwing here would force the
 * conversion ticker to retry forever on a single corrupt row.
 */
export function parseScannerMeta(raw: unknown): ScannerMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const q = obj.quad as Record<string, unknown> | undefined;
  const mode = obj.enhanceMode;
  const size = obj.sourceSize as Record<string, unknown> | undefined;
  if (!q || !size) return null;
  if (mode !== 'color' && mode !== 'grayscale' && mode !== 'bw') return null;
  const corner = (c: unknown): Point | null => {
    if (!c || typeof c !== 'object') return null;
    const p = c as Record<string, unknown>;
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return null;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return { x: p.x, y: p.y };
  };
  const tl = corner(q.topLeft);
  const tr = corner(q.topRight);
  const br = corner(q.bottomRight);
  const bl = corner(q.bottomLeft);
  if (!tl || !tr || !br || !bl) return null;
  if (typeof size.w !== 'number' || typeof size.h !== 'number') return null;
  if (!Number.isFinite(size.w) || !Number.isFinite(size.h)) return null;
  return {
    quad: { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl },
    enhanceMode: mode,
    sourceSize: { w: size.w, h: size.h },
  };
}

/**
 * Solve a 3x3 homography that maps `src` (the four user-placed corners)
 * to the axis-aligned rectangle [(0,0), (w,0), (w,h), (0,h)]. Returns the
 * row-major 9-element matrix [a..h, 1]; `h33` is fixed at 1 because the
 * homography is defined up to scale.
 */
function solvePerspective(src: Quad, w: number, h: number): number[] {
  const dst: Point[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  const s = [src.topLeft, src.topRight, src.bottomRight, src.bottomLeft];
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = s[i]!;
    const { x: u, y: v } = dst[i]!;
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(A[row]![col]!) > Math.abs(A[pivot]![col]!)) pivot = row;
    }
    if (pivot !== col) {
      const tmp = A[col]!;
      A[col] = A[pivot]!;
      A[pivot] = tmp;
    }
    const p = A[col]![col]!;
    if (Math.abs(p) < 1e-12) {
      throw new Error('solvePerspective: degenerate quad (collinear points?)');
    }
    for (let row = col + 1; row < 8; row++) {
      const factor = A[row]![col]! / p;
      for (let k = col; k < 9; k++) {
        A[row]![k] = A[row]![k]! - factor * A[col]![k]!;
      }
    }
  }
  const x = new Array<number>(8).fill(0);
  for (let i = 7; i >= 0; i--) {
    let v = A[i]![8]!;
    for (let j = i + 1; j < 8; j++) v -= A[i]![j]! * x[j]!;
    x[i] = v / A[i]![i]!;
  }
  return [x[0]!, x[1]!, x[2]!, x[3]!, x[4]!, x[5]!, x[6]!, x[7]!, 1];
}

function invert3x3(m: number[]): number[] {
  const a = m[0]!,
    b = m[1]!,
    c = m[2]!;
  const d = m[3]!,
    e = m[4]!,
    f = m[5]!;
  const g = m[6]!,
    h = m[7]!,
    i = m[8]!;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) throw new Error('invert3x3: singular matrix');
  const inv = 1 / det;
  return [
    (e * i - f * h) * inv,
    (c * h - b * i) * inv,
    (b * f - c * e) * inv,
    (f * g - d * i) * inv,
    (a * i - c * g) * inv,
    (c * d - a * f) * inv,
    (d * h - e * g) * inv,
    (b * g - a * h) * inv,
    (a * e - b * d) * inv,
  ];
}

/**
 * Output dimensions from a quad: average of top/bottom edges → width,
 * average of left/right edges → height. Cap at OUTPUT_MAX on long edge
 * so the assembled PDF embeds at a predictable size.
 */
function quadOutputSize(q: Quad): { w: number; h: number } {
  const top = Math.hypot(q.topRight.x - q.topLeft.x, q.topRight.y - q.topLeft.y);
  const bottom = Math.hypot(q.bottomRight.x - q.bottomLeft.x, q.bottomRight.y - q.bottomLeft.y);
  const left = Math.hypot(q.bottomLeft.x - q.topLeft.x, q.bottomLeft.y - q.topLeft.y);
  const right = Math.hypot(q.bottomRight.x - q.topRight.x, q.bottomRight.y - q.topRight.y);
  let w = (top + bottom) / 2;
  let h = (left + right) / 2;
  if (!Number.isFinite(w) || w < 8) w = 8;
  if (!Number.isFinite(h) || h < 8) h = 8;
  const longEdge = Math.max(w, h);
  if (longEdge > OUTPUT_MAX) {
    const k = OUTPUT_MAX / longEdge;
    w *= k;
    h *= k;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

/**
 * Warp + enhance one scanned image. `srcBuffer` is the original camera
 * JPEG/PNG/HEIC as the client uploaded it; `meta.quad` is in that image's
 * natural-pixel frame; the returned Buffer is a JPEG ready to feed to
 * pdf-lib's `embedJpg`.
 *
 * EXIF orientation is consumed before quad sampling — the iOS native
 * camera writes JPEGs with EXIF=6 (rotate 90° CW) and an unrotated buffer
 * would invalidate the user-placed quad. `sharp().rotate()` applies the
 * orientation tag and strips it; subsequent dimensions match what the
 * client measured.
 */
export async function warpAndEnhance(
  srcBuffer: Buffer,
  meta: ScannerMeta,
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  // 1. EXIF-rotate to upright, then strip EXIF, then read raw RGB. We
  //    drop alpha because the warp produces opaque output anyway and
  //    saves us a per-pixel channel.
  const upright = sharp(srcBuffer).rotate();
  const { data: srcPx, info } = await upright
    .raw()
    .toColourspace('srgb')
    .toBuffer({ resolveWithObject: true });
  const srcW = info.width;
  const srcH = info.height;
  const srcChannels = info.channels;
  if (srcChannels < 3) {
    throw new Error(`warpAndEnhance: unexpected channel count ${srcChannels}`);
  }

  // 2. The quad may be in the pre-EXIF-rotation frame if the client
  //    measured against a video element that auto-rotates differently
  //    from a still <img>. Detect by comparing reported size to sharp's
  //    rotated dimensions — when they match exactly we use the quad as-is;
  //    when swapped (w↔h) we rotate the quad 90° to match.
  let quad = meta.quad;
  if (meta.sourceSize.w !== srcW || meta.sourceSize.h !== srcH) {
    if (meta.sourceSize.w === srcH && meta.sourceSize.h === srcW) {
      // sourceSize is the 90° rotation of the actual upright dimensions.
      // Map (x, y) in the rotated frame → (y, w - x) in the upright frame.
      const rotate = (p: Point): Point => ({ x: p.y, y: meta.sourceSize.w - p.x });
      quad = {
        topLeft: rotate(meta.quad.topLeft),
        topRight: rotate(meta.quad.topRight),
        bottomRight: rotate(meta.quad.bottomRight),
        bottomLeft: rotate(meta.quad.bottomLeft),
      };
    } else {
      // Best-effort scale to current dimensions; this is the recovery
      // path for a client that resized the source before measuring.
      const sx = srcW / meta.sourceSize.w;
      const sy = srcH / meta.sourceSize.h;
      const scale = (p: Point): Point => ({ x: p.x * sx, y: p.y * sy });
      quad = {
        topLeft: scale(meta.quad.topLeft),
        topRight: scale(meta.quad.topRight),
        bottomRight: scale(meta.quad.bottomRight),
        bottomLeft: scale(meta.quad.bottomLeft),
      };
    }
  }

  // 3. Pick output dimensions from edge averages and run the warp.
  const out = quadOutputSize(quad);
  const outW = out.w;
  const outH = out.h;
  const Hfwd = solvePerspective(quad, outW, outH);
  const Hinv = invert3x3(Hfwd);

  // Allocate the destination buffer. RGB (3 channels) — matches what we
  // hand back to sharp. Uint8Array because Buffer.fill(0) is just a zero
  // initial state and a typed array reads slightly faster in the hot loop.
  const dst = Buffer.alloc(outW * outH * 3);

  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      const sx = Hinv[0]! * u + Hinv[1]! * v + Hinv[2]!;
      const sy = Hinv[3]! * u + Hinv[4]! * v + Hinv[5]!;
      const sw = Hinv[6]! * u + Hinv[7]! * v + Hinv[8]!;
      const x = sx / sw;
      const y = sy / sw;
      const di = (v * outW + u) * 3;
      if (x < 0 || x >= srcW - 1 || y < 0 || y >= srcH - 1) {
        // Out of bounds — opaque black. JPEG has no alpha so leaving zero
        // is fine; the borders are the rare case where the user dragged a
        // corner slightly outside the photo.
        dst[di] = 0;
        dst[di + 1] = 0;
        dst[di + 2] = 0;
        continue;
      }
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const fx = x - xi;
      const fy = y - yi;
      // Source stride accounts for whatever channel count sharp emitted
      // (3 for sRGB, 4 if the input was RGBA — we still only sample the
      // first three channels).
      const stride = srcChannels;
      const i00 = (yi * srcW + xi) * stride;
      const i10 = i00 + stride;
      const i01 = i00 + srcW * stride;
      const i11 = i01 + stride;
      for (let c = 0; c < 3; c++) {
        const v00 = srcPx[i00 + c]!;
        const v10 = srcPx[i10 + c]!;
        const v01 = srcPx[i01 + c]!;
        const v11 = srcPx[i11 + c]!;
        const top = v00 * (1 - fx) + v10 * fx;
        const bot = v01 * (1 - fx) + v11 * fx;
        dst[di + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }

  // 4. Enhance in-place on the raw buffer before re-encoding. Skips the
  //    grayscale/bw paths for color mode (the JPEG encoder handles that).
  applyEnhance(dst, outW, outH, meta.enhanceMode);

  // 5. Re-encode as JPEG via sharp. We hand back raw bytes + the
  //    dimensions so the caller can choose whether to embed directly or
  //    do another sharp pass (the PDF builder embeds directly).
  const jpeg = await sharp(dst, { raw: { width: outW, height: outH, channels: 3 } })
    .jpeg({ quality: 85, chromaSubsampling: '4:2:0' })
    .toBuffer();
  return { jpeg, width: outW, height: outH };
}

/**
 * In-place enhance on a raw RGB buffer. grayscale: ITU-R BT.601 luma.
 * bw: adaptive-threshold via summed-area-table local mean (block size
 * scaled to the shorter image edge / 25; offset 10). Mirrors the math in
 * `apps/intake/src/components/scannerMath.ts` so the visual output is
 * identical between legacy client-warped and current server-warped
 * uploads.
 */
function applyEnhance(buf: Buffer, w: number, h: number, mode: EnhanceMode): void {
  if (mode === 'color') return;

  if (mode === 'grayscale') {
    for (let i = 0; i < buf.length; i += 3) {
      const r = buf[i]!;
      const g = buf[i + 1]!;
      const b = buf[i + 2]!;
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      buf[i] = y;
      buf[i + 1] = y;
      buf[i + 2] = y;
    }
    return;
  }

  // mode === 'bw'.
  const luma = new Float32Array(w * h);
  for (let i = 0, j = 0; i < buf.length; i += 3, j++) {
    luma[j] = 0.299 * buf[i]! + 0.587 * buf[i + 1]! + 0.114 * buf[i + 2]!;
  }
  // Summed-area table on a (w+1)×(h+1) grid (first row/column are zeros
  // so the inclusion-exclusion formula has no boundary special-case).
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += luma[y * w + x]!;
      integ[(y + 1) * (w + 1) + (x + 1)] = integ[y * (w + 1) + (x + 1)]! + rowSum;
    }
  }
  const block = Math.max(15, Math.floor(Math.min(w, h) / 25));
  const half = block >> 1;
  const offset = 10;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(h, y + half + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(w, x + half + 1);
      const area = (x1 - x0) * (y1 - y0);
      const sum =
        integ[y1 * (w + 1) + x1]! -
        integ[y0 * (w + 1) + x1]! -
        integ[y1 * (w + 1) + x0]! +
        integ[y0 * (w + 1) + x0]!;
      const mean = sum / area;
      const v = luma[y * w + x]! < mean - offset ? 0 : 255;
      const i = (y * w + x) * 3;
      buf[i] = v;
      buf[i + 1] = v;
      buf[i + 2] = v;
    }
  }
}

// ---------- Server-side document detection ----------
//
// v0.4.29 — client-side OpenCV/jscanify was removed (iOS Safari hang at
// the "Loading…" screen, see commit 3ac6e94). Captures now upload raw
// and the server decides whether a quadrilateral document is in the
// frame; if so, the existing `warpAndEnhance` rectifies it. If not,
// `intakePdfBuilder.ts` falls back to embedding the EXIF-rotated photo
// as-is so the user still gets their content into the PDF.
//
// Algorithm trade-offs (no native OpenCV, just sharp + pure JS):
//   - Otsu thresholding handles bimodal "document vs background" well
//     when the document is meaningfully brighter than the surface it
//     sits on. White paper on a dark/wooden desk: works. White paper
//     on a beige conference-room desk with similar luminance: fails
//     to find a usable component, returns null, caller falls back.
//   - BFS connected-component finds the largest bright region; this
//     is the document for any normal phone framing.
//   - Extreme-point heuristic for corners (argmin/max of x±y) is
//     accurate enough at this working resolution that the warp's
//     bilinear sampler covers any sub-pixel error. True convex-hull
//     extraction would be more code without visible benefit.
//
// Performance: ~150-300 ms on a 12 MP iPhone JPEG on an appliance-
// class Xeon Bronze. Runs inside the PDF conversion ticker, off the
// HTTP path.

/**
 * Run Otsu's method on a greyscale histogram. Returns the threshold
 * (0-255) that maximises between-class variance — the standard
 * bimodal-segmentation cut. Exported for unit-testability; production
 * callers go through `detectDocumentQuad`.
 */
export function otsuThreshold(histogram: Uint32Array | number[]): number {
  let total = 0;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) {
    total += histogram[t]!;
    sumAll += t * histogram[t]!;
  }
  if (total === 0) return 128;
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += histogram[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * histogram[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) {
      maxVar = v;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Find the largest connected component in a binary mask using 4-way
 * connectivity (up/down/left/right; diagonals can chain across narrow
 * gaps and merge separate objects). Returns the label assigned to that
 * component, the labels array, and its size in pixels. Exported for
 * test-only assertion of correctness on synthetic masks.
 */
export function largestConnectedComponent(
  mask: Uint8Array,
  w: number,
  h: number,
): { labels: Int32Array; bestLabel: number; bestSize: number } {
  const labels = new Int32Array(w * h);
  let bestLabel = 0;
  let bestSize = 0;
  let nextLabel = 1;
  // Queue is reused across components — clearing length is cheaper than
  // re-allocating, and the worst-case queue depth is the component size.
  const queue: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const myLabel = nextLabel++;
    labels[start] = myLabel;
    let size = 1;
    queue.length = 0;
    queue.push(start);
    // Head pointer instead of Array.shift() — shift is O(n) which would
    // make BFS O(component^2) on Chrome/V8 (less of an issue on Node,
    // but the cost is real for a 100k-pixel component).
    let head = 0;
    while (head < queue.length) {
      const p = queue[head++]!;
      const px = p % w;
      const py = (p - px) / w;
      if (px > 0) {
        const n = p - 1;
        if (mask[n] && !labels[n]) {
          labels[n] = myLabel;
          size++;
          queue.push(n);
        }
      }
      if (px < w - 1) {
        const n = p + 1;
        if (mask[n] && !labels[n]) {
          labels[n] = myLabel;
          size++;
          queue.push(n);
        }
      }
      if (py > 0) {
        const n = p - w;
        if (mask[n] && !labels[n]) {
          labels[n] = myLabel;
          size++;
          queue.push(n);
        }
      }
      if (py < h - 1) {
        const n = p + w;
        if (mask[n] && !labels[n]) {
          labels[n] = myLabel;
          size++;
          queue.push(n);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = myLabel;
    }
  }
  return { labels, bestLabel, bestSize };
}

/**
 * Extreme-point corner heuristic. For each pixel belonging to the
 * target component, pick the indices minimising / maximising the four
 * rotated coordinates:
 *
 *   topLeft     = argmin(x + y)
 *   topRight    = argmax(x - y)
 *   bottomRight = argmax(x + y)
 *   bottomLeft  = argmax(y - x)
 *
 * These four extremes coincide with the actual quadrilateral corners
 * for any convex shape rotated < 45° from axis-aligned, which covers
 * any reasonable phone-held document frame. Exported for testability.
 */
export function extremeCorners(labels: Int32Array, target: number, w: number): Quad | null {
  let tlIdx = -1;
  let tlScore = Infinity;
  let trIdx = -1;
  let trScore = -Infinity;
  let brIdx = -1;
  let brScore = -Infinity;
  let blIdx = -1;
  let blScore = -Infinity;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== target) continue;
    const x = i % w;
    const y = (i - x) / w;
    const xPlusY = x + y;
    const xMinusY = x - y;
    const yMinusX = y - x;
    if (xPlusY < tlScore) {
      tlScore = xPlusY;
      tlIdx = i;
    }
    if (xPlusY > brScore) {
      brScore = xPlusY;
      brIdx = i;
    }
    if (xMinusY > trScore) {
      trScore = xMinusY;
      trIdx = i;
    }
    if (yMinusX > blScore) {
      blScore = yMinusX;
      blIdx = i;
    }
  }
  if (tlIdx < 0 || trIdx < 0 || brIdx < 0 || blIdx < 0) return null;
  const toPoint = (idx: number): Point => {
    const x = idx % w;
    const y = (idx - x) / w;
    return { x, y };
  };
  return {
    topLeft: toPoint(tlIdx),
    topRight: toPoint(trIdx),
    bottomRight: toPoint(brIdx),
    bottomLeft: toPoint(blIdx),
  };
}

/**
 * Best-effort server-side document detection. Pipeline:
 *
 *   1. EXIF-rotate the source so corner coordinates match what the
 *      warp's `sourceSize` check expects.
 *   2. Downscale to DETECT_WORK_EDGE on the long edge + greyscale +
 *      Gaussian blur. Smaller working size is fast AND denoises JPEG
 *      block edges that would otherwise create spurious bright/dark
 *      transitions inside the document.
 *   3. Otsu threshold to split bright (document) from dark (surface).
 *   4. BFS for the largest bright component.
 *   5. Confidence floor at DETECT_MIN_AREA_FRACTION — small components
 *      mean the photo doesn't have a high-contrast document, or the
 *      threshold caught a glare patch. Bail to null; caller falls back
 *      to no-crop.
 *   6. Extreme-point corner extraction, scaled back to natural pixels.
 *
 * Returns null when detection is low-confidence; the caller is
 * expected to fall back to embedding the photo as-is.
 */
export async function detectDocumentQuad(
  srcBuffer: Buffer,
): Promise<{ quad: Quad; sourceSize: { w: number; h: number } } | null> {
  const upright = sharp(srcBuffer).rotate();
  const uprightMeta = await upright.metadata();
  const fullW = uprightMeta.width;
  const fullH = uprightMeta.height;
  if (!fullW || !fullH) return null;

  const longEdge = Math.max(fullW, fullH);
  const scale = longEdge > DETECT_WORK_EDGE ? DETECT_WORK_EDGE / longEdge : 1;
  const workW = Math.max(1, Math.round(fullW * scale));
  const workH = Math.max(1, Math.round(fullH * scale));

  const { data: grey, info } = await upright
    .clone()
    .resize(workW, workH, { fit: 'fill' })
    .greyscale()
    .blur(1.2)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  // sharp's .greyscale().raw() emits 1 byte per pixel; sanity check
  // before indexing as such (a future sharp behaviour change here
  // would silently produce nonsense).
  if (grey.length !== w * h) return null;

  const histogram = new Uint32Array(256);
  for (let i = 0; i < grey.length; i++) {
    const bucket = grey[i]!;
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }
  const threshold = otsuThreshold(histogram);

  const mask = new Uint8Array(w * h);
  for (let i = 0; i < grey.length; i++) mask[i] = grey[i]! > threshold ? 1 : 0;

  const { labels, bestLabel, bestSize } = largestConnectedComponent(mask, w, h);
  if (bestLabel === 0 || bestSize / (w * h) < DETECT_MIN_AREA_FRACTION) return null;

  const workQuad = extremeCorners(labels, bestLabel, w);
  if (!workQuad) return null;

  // Scale corners from working frame back to natural-image frame.
  const inv = 1 / scale;
  const lift = (p: Point): Point => ({ x: p.x * inv, y: p.y * inv });
  return {
    quad: {
      topLeft: lift(workQuad.topLeft),
      topRight: lift(workQuad.topRight),
      bottomRight: lift(workQuad.bottomRight),
      bottomLeft: lift(workQuad.bottomLeft),
    },
    sourceSize: { w: fullW, h: fullH },
  };
}

/**
 * Convenience composition: detect a document quad, then warp +
 * enhance. Used by the PDF builder for uploads without client-
 * supplied scanner metadata (i.e. every upload as of v0.4.29 —
 * the client review/crop step was removed). Returns null when
 * detection is low-confidence so the caller can fall back to the
 * EXIF-rotate-only path.
 *
 * Default enhanceMode = 'grayscale' matches the prior client-side
 * default, keeps text crisp, and produces smaller PDFs than color
 * for the typical CPA-document-on-white-paper case.
 */
export async function autoDetectAndWarp(
  srcBuffer: Buffer,
  enhanceMode: EnhanceMode = 'grayscale',
): Promise<{ jpeg: Buffer; width: number; height: number } | null> {
  const detected = await detectDocumentQuad(srcBuffer);
  if (!detected) return null;
  return warpAndEnhance(srcBuffer, {
    quad: detected.quad,
    sourceSize: detected.sourceSize,
    enhanceMode,
  });
}
