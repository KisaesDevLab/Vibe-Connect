// Phase 28.7 — perspective transform + enhancement math for the scanner.
//
// We intentionally do NOT depend on OpenCV.js at runtime: it's ~7 MB and
// would blow the build plan's scanner-chunk size budget, and a CPA-firm
// appliance running in TLS-internal mode often has no path to a public
// CDN. jscanify (the suggested auto-detect library in the build plan) is
// a thin wrapper around OpenCV — it stays in package.json so an operator
// can vendor OpenCV alongside the appliance later if they want the
// 8/10-auto-crop convenience, but the scanner works without it.
//
// What's in this file:
//   - `solvePerspective(src, dst)` — compute the 3x3 homography matrix that
//     maps four source points to four destination points via the
//     standard 8-unknown linear system. ~30 lines of Gaussian elimination.
//   - `warpPerspective(src, srcQuad, outW, outH)` — sample the source canvas
//     through the homography to produce a deskewed rectangular output.
//     Per-pixel JS, ~200-500ms for a 2000×2828 result on a 2022 mid-tier
//     Android (within the 800ms detection + 400ms transform budget the
//     build plan calls for, combined).
//   - `enhance(canvas, mode)` — color / grayscale / B&W canvas operation.

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

/**
 * Solve a 3x3 homography that maps the four source points to (0,0),(w,0),
 * (w,h),(0,h) where (w, h) are the destination dimensions. The classic
 * approach: build the 8×9 augmented matrix from the four point
 * correspondences, eliminate to row-echelon, back-substitute.
 *
 * Returns a flat 9-element array [a, b, c, d, e, f, g, h, 1] representing
 * the homography in row-major order. `i` is fixed at 1 because the
 * homography is defined up to scale.
 */
export function solvePerspective(src: Quad, w: number, h: number): number[] {
  // Destination is the axis-aligned rectangle of size (w, h).
  const dst: Point[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  const s = [src.topLeft, src.topRight, src.bottomRight, src.bottomLeft];

  // 8x9 augmented matrix. Each point gives two rows of the form
  //   [x, y, 1, 0, 0, 0, -x*u, -y*u | u]
  //   [0, 0, 0, x, y, 1, -x*v, -y*v | v]
  // where (x, y) is src and (u, v) is dst.
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = s[i]!;
    const { x: u, y: v } = dst[i]!;
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }

  // Gaussian elimination with partial pivoting.
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

  // Back-substitute.
  const x = new Array<number>(8).fill(0);
  for (let i = 7; i >= 0; i--) {
    let v = A[i]![8]!;
    for (let j = i + 1; j < 8; j++) v -= A[i]![j]! * x[j]!;
    x[i] = v / A[i]![i]!;
  }
  // x = [h11, h12, h13, h21, h22, h23, h31, h32], with h33 = 1.
  return [x[0]!, x[1]!, x[2]!, x[3]!, x[4]!, x[5]!, x[6]!, x[7]!, 1];
}

/**
 * Apply the inverse perspective transform: for each output pixel, sample
 * the source canvas via bilinear interpolation through the inverse
 * homography. Returns a new HTMLCanvasElement of size (outW, outH).
 */
export function warpPerspective(
  src: HTMLCanvasElement | HTMLImageElement,
  srcQuad: Quad,
  outW: number,
  outH: number,
): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const outCtx = out.getContext('2d');
  if (!outCtx) throw new Error('warpPerspective: 2D context unavailable');

  // We need the source pixel data — render the source onto a scratch
  // canvas so we can read ImageData regardless of whether `src` is an
  // <img> or a <canvas>. (Direct ImageData on an <img> isn't possible.)
  let srcCanvas: HTMLCanvasElement;
  let srcW: number;
  let srcH: number;
  if (src instanceof HTMLCanvasElement) {
    srcCanvas = src;
    srcW = src.width;
    srcH = src.height;
  } else {
    srcW = src.naturalWidth;
    srcH = src.naturalHeight;
    srcCanvas = document.createElement('canvas');
    srcCanvas.width = srcW;
    srcCanvas.height = srcH;
    const c = srcCanvas.getContext('2d');
    if (!c) throw new Error('warpPerspective: scratch context unavailable');
    c.drawImage(src, 0, 0);
  }
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) throw new Error('warpPerspective: source context unavailable');
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
  const srcPx = srcData.data;

  // We want the inverse map: given dest (u, v) → source (x, y). The
  // forward homography we solved is src → dest, so we invert it once and
  // apply per-pixel.
  const Hfwd = solvePerspective(srcQuad, outW, outH);
  const Hinv = invert3x3(Hfwd);

  const dstData = outCtx.createImageData(outW, outH);
  const dstPx = dstData.data;

  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      // (u, v, 1) → source homogeneous coords.
      const sx = Hinv[0]! * u + Hinv[1]! * v + Hinv[2]!;
      const sy = Hinv[3]! * u + Hinv[4]! * v + Hinv[5]!;
      const sw = Hinv[6]! * u + Hinv[7]! * v + Hinv[8]!;
      const x = sx / sw;
      const y = sy / sw;
      const di = (v * outW + u) * 4;
      if (x < 0 || x >= srcW - 1 || y < 0 || y >= srcH - 1) {
        // Out-of-bounds — paint black + opaque so the caller's enhance
        // step doesn't see RGBA(0,0,0,0) garbage that the JPEG encoder
        // turns into magenta.
        dstPx[di] = 0;
        dstPx[di + 1] = 0;
        dstPx[di + 2] = 0;
        dstPx[di + 3] = 255;
        continue;
      }
      // Bilinear sample.
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const fx = x - xi;
      const fy = y - yi;
      const i00 = (yi * srcW + xi) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + srcW * 4;
      const i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        const v00 = srcPx[i00 + c]!;
        const v10 = srcPx[i10 + c]!;
        const v01 = srcPx[i01 + c]!;
        const v11 = srcPx[i11 + c]!;
        const top = v00 * (1 - fx) + v10 * fx;
        const bot = v01 * (1 - fx) + v11 * fx;
        dstPx[di + c] = Math.round(top * (1 - fy) + bot * fy);
      }
      dstPx[di + 3] = 255;
    }
  }
  outCtx.putImageData(dstData, 0, 0);
  return out;
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

export type EnhanceMode = 'color' | 'grayscale' | 'bw';

/**
 * Apply the user's enhancement choice on the perspective-corrected output.
 *   color     — pass-through.
 *   grayscale — ITU-R BT.601 luma weights.
 *   bw        — adaptive threshold (block mean - constant). Block size
 *               and offset chosen for legibility on photographed white
 *               paper under indoor light; tune later if 28.17 visual QA
 *               shows it's wrong on a phone-flashlight shot.
 */
export function enhance(canvas: HTMLCanvasElement, mode: EnhanceMode): HTMLCanvasElement {
  if (mode === 'color') return canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  if (mode === 'grayscale') {
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i]!;
      const g = px[i + 1]!;
      const b = px[i + 2]!;
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      px[i] = y;
      px[i + 1] = y;
      px[i + 2] = y;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // mode === 'bw' — adaptive threshold (mean filter with a small offset).
  // First pass writes luma into a separate Float32Array; second pass
  // computes a moving-average box blur via integral image; third pass
  // thresholds. Integral image keeps the box-mean O(1) per pixel
  // regardless of window size, which matters for the 2000×2828 worst case.
  const luma = new Float32Array(w * h);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    luma[j] = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
  }
  // Integral image (summed-area table).
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
  const offset = 10; // subtract this from the local mean for the threshold
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
      const i = (y * w + x) * 4;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Best-effort auto-detect via jscanify if `window.cv` (OpenCV.js) is
 * already loaded on the page. Returns null if jscanify or OpenCV isn't
 * available; callers fall back to the default near-edges quad.
 *
 * Operators who want the 8/10-auto-crop convenience the build plan calls
 * for can vendor opencv.js into `apps/intake/public/` and load it via a
 * <script> tag in the public index.html. We don't bundle OpenCV here
 * because it's ~7 MB and would blow the scanner-chunk size budget.
 */
export async function tryAutoDetect(img: HTMLImageElement): Promise<Quad | null> {
  // window.cv is the OpenCV.js global. Without it, jscanify throws.
  const w = window as unknown as { cv?: unknown };
  if (!w.cv) return null;
  try {
    // jscanify ships no .d.ts; the ambient declaration in
    // src/jscanify.d.ts gives us a tiny typed surface for what we use.
    const mod = (await import('jscanify')) as unknown;
    const Scanner = (mod as { default?: new () => unknown }).default ?? mod;
    interface JscanifyApi {
      getCornerPoints: (img: HTMLImageElement) => {
        topLeftCorner: Point;
        topRightCorner: Point;
        bottomRightCorner: Point;
        bottomLeftCorner: Point;
      };
    }
    const s = new (Scanner as new () => JscanifyApi)();
    const c = s.getCornerPoints(img);
    if (!c.topLeftCorner) return null;
    return {
      topLeft: c.topLeftCorner,
      topRight: c.topRightCorner,
      bottomRight: c.bottomRightCorner,
      bottomLeft: c.bottomLeftCorner,
    };
  } catch {
    return null;
  }
}

/**
 * Default quad for the fallback path: 8% inset from each edge so the
 * user can see all four handles without having to drag from the corner.
 */
export function defaultQuad(w: number, h: number): Quad {
  const dx = w * 0.08;
  const dy = h * 0.08;
  return {
    topLeft: { x: dx, y: dy },
    topRight: { x: w - dx, y: dy },
    bottomRight: { x: w - dx, y: h - dy },
    bottomLeft: { x: dx, y: h - dy },
  };
}

/**
 * Compute output dimensions from a quad: average of the top/bottom edge
 * lengths gives the output width; average of the left/right edge lengths
 * gives the height. Then scale to fit ≤ `maxEdge` on the long edge.
 */
export function quadOutputSize(q: Quad, maxEdge: number): { w: number; h: number } {
  const top = Math.hypot(q.topRight.x - q.topLeft.x, q.topRight.y - q.topLeft.y);
  const bottom = Math.hypot(q.bottomRight.x - q.bottomLeft.x, q.bottomRight.y - q.bottomLeft.y);
  const left = Math.hypot(q.bottomLeft.x - q.topLeft.x, q.bottomLeft.y - q.topLeft.y);
  const right = Math.hypot(q.bottomRight.x - q.topRight.x, q.bottomRight.y - q.topRight.y);
  let w = (top + bottom) / 2;
  let h = (left + right) / 2;
  if (!Number.isFinite(w) || w < 8) w = 8;
  if (!Number.isFinite(h) || h < 8) h = 8;
  const longEdge = Math.max(w, h);
  if (longEdge > maxEdge) {
    const k = maxEdge / longEdge;
    w *= k;
    h *= k;
  }
  return { w: Math.round(w), h: Math.round(h) };
}
