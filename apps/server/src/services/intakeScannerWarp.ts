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
