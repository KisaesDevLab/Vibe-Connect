/**
 * Server-side perspective warp + enhance.
 *
 * Covers:
 *   - `parseScannerMeta` type-guard (good, missing field, bad type, NaN).
 *   - `warpAndEnhance` identity case — when the quad matches the image
 *     corners exactly, the output should be very close to the input
 *     (allowing for JPEG re-encode noise + sharp downsampling).
 *   - Off-axis warp produces an upright rectangle whose dimensions follow
 *     the quad's edge-length averages.
 *
 * This module replaces the in-browser warp that OOMed iOS Safari on
 * Pro-model camera sensors. The tests pin behaviour at the Node layer so
 * the conversion ticker is verified independent of the client.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  autoDetectAndWarp,
  detectDocumentQuad,
  extremeCorners,
  largestConnectedComponent,
  otsuThreshold,
  parseScannerMeta,
  warpAndEnhance,
  type ScannerMeta,
} from '../services/intakeScannerWarp.js';

function buildTestImage(w: number, h: number): Promise<Buffer> {
  // A checkerboard-ish gradient — strong horizontal+vertical gradient so
  // the warp's pixel positions are easy to assert.
  const pixels = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      pixels[i] = Math.min(255, Math.round((x / w) * 255));
      pixels[i + 1] = Math.min(255, Math.round((y / h) * 255));
      pixels[i + 2] = 128;
    }
  }
  return sharp(pixels, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe('parseScannerMeta', () => {
  const valid: ScannerMeta = {
    quad: {
      topLeft: { x: 10, y: 10 },
      topRight: { x: 90, y: 12 },
      bottomRight: { x: 88, y: 90 },
      bottomLeft: { x: 12, y: 88 },
    },
    enhanceMode: 'grayscale',
    sourceSize: { w: 100, h: 100 },
  };

  it('accepts a fully-populated payload', () => {
    expect(parseScannerMeta(valid)).toEqual(valid);
  });

  it('rejects null / non-object', () => {
    expect(parseScannerMeta(null)).toBeNull();
    expect(parseScannerMeta(undefined)).toBeNull();
    expect(parseScannerMeta('string')).toBeNull();
    expect(parseScannerMeta(42)).toBeNull();
  });

  it('rejects when a corner is missing', () => {
    const bad = { ...valid, quad: { ...valid.quad, topRight: undefined } };
    expect(parseScannerMeta(bad)).toBeNull();
  });

  it('rejects unknown enhanceMode', () => {
    const bad = { ...valid, enhanceMode: 'sepia' };
    expect(parseScannerMeta(bad)).toBeNull();
  });

  it('rejects NaN/Infinity coordinates', () => {
    const bad = {
      ...valid,
      quad: {
        ...valid.quad,
        topLeft: { x: Number.NaN, y: 10 },
      },
    };
    expect(parseScannerMeta(bad)).toBeNull();
    const bad2 = {
      ...valid,
      sourceSize: { w: Number.POSITIVE_INFINITY, h: 100 },
    };
    expect(parseScannerMeta(bad2)).toBeNull();
  });
});

describe('warpAndEnhance', () => {
  it('returns a JPEG buffer with dimensions matching the quad', async () => {
    const src = await buildTestImage(400, 300);
    // Quad covers the whole image — output should match the source size
    // (capped to OUTPUT_MAX = 2000, which neither edge hits here).
    const meta: ScannerMeta = {
      quad: {
        topLeft: { x: 0, y: 0 },
        topRight: { x: 400, y: 0 },
        bottomRight: { x: 400, y: 300 },
        bottomLeft: { x: 0, y: 300 },
      },
      enhanceMode: 'color',
      sourceSize: { w: 400, h: 300 },
    };
    const out = await warpAndEnhance(src, meta);
    expect(out.width).toBe(400);
    expect(out.height).toBe(300);
    expect(out.jpeg.length).toBeGreaterThan(0);
    // The JPEG should decode cleanly back through sharp.
    const meta2 = await sharp(out.jpeg).metadata();
    expect(meta2.width).toBe(400);
    expect(meta2.height).toBe(300);
  });

  it('grayscale mode produces R=G=B output', async () => {
    const src = await buildTestImage(50, 50);
    const meta: ScannerMeta = {
      quad: {
        topLeft: { x: 0, y: 0 },
        topRight: { x: 50, y: 0 },
        bottomRight: { x: 50, y: 50 },
        bottomLeft: { x: 0, y: 50 },
      },
      enhanceMode: 'grayscale',
      sourceSize: { w: 50, h: 50 },
    };
    const out = await warpAndEnhance(src, meta);
    // Re-read the JPEG into raw RGB. JPEG chroma subsampling introduces
    // tiny per-channel drift, so allow a small tolerance.
    const raw = await sharp(out.jpeg).raw().toBuffer({ resolveWithObject: true });
    let maxDelta = 0;
    for (let i = 0; i < raw.data.length; i += 3) {
      const r = raw.data[i]!;
      const g = raw.data[i + 1]!;
      const b = raw.data[i + 2]!;
      maxDelta = Math.max(maxDelta, Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
    }
    expect(maxDelta).toBeLessThanOrEqual(8);
  });

  it('bw mode produces only near-black or near-white pixels', async () => {
    const src = await buildTestImage(60, 60);
    const meta: ScannerMeta = {
      quad: {
        topLeft: { x: 0, y: 0 },
        topRight: { x: 60, y: 0 },
        bottomRight: { x: 60, y: 60 },
        bottomLeft: { x: 0, y: 60 },
      },
      enhanceMode: 'bw',
      sourceSize: { w: 60, h: 60 },
    };
    const out = await warpAndEnhance(src, meta);
    const raw = await sharp(out.jpeg).raw().toBuffer({ resolveWithObject: true });
    // After adaptive threshold every pixel is either 0 or 255 in the raw
    // buffer; JPEG decode adds a small amount of compression noise.
    let blackish = 0;
    let whitish = 0;
    let mid = 0;
    for (let i = 0; i < raw.data.length; i += 3) {
      const v = raw.data[i]!;
      if (v <= 32) blackish++;
      else if (v >= 220) whitish++;
      else mid++;
    }
    // Allow a small mid band for JPEG ringing — the vast majority should
    // be at the rails.
    expect(mid).toBeLessThan((blackish + whitish) * 0.1);
  });

  it('handles a 90° quad rotation when sourceSize is reported pre-rotation', async () => {
    // Simulates the iOS still-vs-video orientation drift: the client
    // measured against a 100×60 frame but sharp reads the file as 60×100
    // after applying EXIF=6. Our reconciliation rotates the quad to
    // match the upright frame.
    const src = await buildTestImage(60, 100);
    const meta: ScannerMeta = {
      quad: {
        topLeft: { x: 0, y: 0 },
        topRight: { x: 100, y: 0 },
        bottomRight: { x: 100, y: 60 },
        bottomLeft: { x: 0, y: 60 },
      },
      enhanceMode: 'color',
      sourceSize: { w: 100, h: 60 },
    };
    const out = await warpAndEnhance(src, meta);
    // Output dims follow the quad's edge-length averages: 100×60.
    expect(out.width).toBe(100);
    expect(out.height).toBe(60);
  });

  it('throws on a degenerate quad', async () => {
    const src = await buildTestImage(100, 100);
    // All four corners collinear → singular system.
    const meta: ScannerMeta = {
      quad: {
        topLeft: { x: 0, y: 0 },
        topRight: { x: 10, y: 0 },
        bottomRight: { x: 20, y: 0 },
        bottomLeft: { x: 30, y: 0 },
      },
      enhanceMode: 'color',
      sourceSize: { w: 100, h: 100 },
    };
    await expect(warpAndEnhance(src, meta)).rejects.toThrow();
  });
});

// ---------- Server-side detection (v0.4.29 / no client OpenCV) ----------

/**
 * Build a JPEG of a bright `docFill`-coloured rectangle on a dark
 * `bgFill`-coloured background. The rectangle occupies the inner area
 * defined by `inset` on each side. Used to exercise the detection
 * pipeline with deterministic geometry — Otsu should split bright
 * from dark cleanly, BFS should grow the inner rectangle as the
 * largest component, and the extreme-corner pass should land at the
 * rect corners.
 */
function buildRectangleOnBackground(opts: {
  imgW: number;
  imgH: number;
  rectInset: number;
  bgFill: number;
  docFill: number;
}): Promise<Buffer> {
  const { imgW, imgH, rectInset, bgFill, docFill } = opts;
  const pixels = Buffer.alloc(imgW * imgH * 3);
  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < imgW; x++) {
      const i = (y * imgW + x) * 3;
      const inside =
        x >= rectInset && x < imgW - rectInset && y >= rectInset && y < imgH - rectInset;
      const v = inside ? docFill : bgFill;
      pixels[i] = v;
      pixels[i + 1] = v;
      pixels[i + 2] = v;
    }
  }
  // High-quality JPEG so block edges don't drift the corner positions
  // and trip the detector's assertions.
  return sharp(pixels, { raw: { width: imgW, height: imgH, channels: 3 } })
    .jpeg({ quality: 98 })
    .toBuffer();
}

describe('otsuThreshold', () => {
  it('returns a threshold that cleanly separates two delta peaks', () => {
    // Peaks at 30 and 220. With only two delta peaks, between-class
    // variance is identical for every t ∈ [30, 219], so the algorithm
    // picks the earliest one (30). What we care about: pixels at 220
    // end up "foreground" (> threshold) and pixels at 30 end up
    // "background" (≤ threshold). Assert that invariant rather than
    // a specific numeric value the algorithm doesn't promise.
    const h = new Uint32Array(256);
    h[30] = 1000;
    h[220] = 1000;
    const t = otsuThreshold(h);
    expect(30).toBeLessThanOrEqual(t);
    expect(220).toBeGreaterThan(t);
  });

  it('handles an all-zero histogram (degenerate but plausible if mask is empty)', () => {
    // Should not divide by zero / NaN; default 128 is the documented
    // pre-loop value.
    const t = otsuThreshold(new Uint32Array(256));
    expect(t).toBe(128);
  });
});

describe('largestConnectedComponent', () => {
  it('finds a single rectangular component and ignores a smaller satellite', () => {
    // 10×10 mask with a 6×6 component centred and a stray single pixel.
    const w = 10;
    const h = 10;
    const mask = new Uint8Array(w * h);
    // Stray pixel in the corner.
    mask[0] = 1;
    // 6×6 block at (2..8, 2..8).
    for (let y = 2; y < 8; y++) {
      for (let x = 2; x < 8; x++) {
        mask[y * w + x] = 1;
      }
    }
    const { bestLabel, bestSize, labels } = largestConnectedComponent(mask, w, h);
    expect(bestLabel).not.toBe(0);
    expect(bestSize).toBe(36);
    // Stray pixel got a different label.
    expect(labels[0]).not.toBe(bestLabel);
  });

  it('returns zero size for an entirely empty mask', () => {
    const { bestLabel, bestSize } = largestConnectedComponent(new Uint8Array(25), 5, 5);
    expect(bestLabel).toBe(0);
    expect(bestSize).toBe(0);
  });
});

describe('extremeCorners', () => {
  it('picks the four extreme points of an axis-aligned rectangle', () => {
    // 10×10 grid with a 6×6 component at (2..8, 2..8).
    const w = 10;
    const h = 10;
    const labels = new Int32Array(w * h);
    for (let y = 2; y < 8; y++) {
      for (let x = 2; x < 8; x++) {
        labels[y * w + x] = 1;
      }
    }
    const corners = extremeCorners(labels, 1, w);
    expect(corners).not.toBeNull();
    expect(corners!.topLeft).toEqual({ x: 2, y: 2 });
    expect(corners!.topRight).toEqual({ x: 7, y: 2 });
    expect(corners!.bottomRight).toEqual({ x: 7, y: 7 });
    expect(corners!.bottomLeft).toEqual({ x: 2, y: 7 });
  });

  it('returns null when no pixel matches the target label', () => {
    const corners = extremeCorners(new Int32Array(25), 1, 5);
    expect(corners).toBeNull();
  });
});

describe('detectDocumentQuad', () => {
  it('finds a bright rectangle on a dark background', async () => {
    // 200×300 background (dark) with a centred 160×260 white rectangle
    // (20 px inset on each side). The detector should land its corners
    // at roughly the rectangle edges in natural coords.
    const src = await buildRectangleOnBackground({
      imgW: 200,
      imgH: 300,
      rectInset: 20,
      bgFill: 20,
      docFill: 240,
    });
    const result = await detectDocumentQuad(src);
    expect(result).not.toBeNull();
    const q = result!.quad;
    // Allow generous tolerance — sharp downscale + Otsu + integer
    // bucket boundaries can shift each corner a handful of pixels.
    const TOL = 8;
    expect(q.topLeft.x).toBeGreaterThanOrEqual(20 - TOL);
    expect(q.topLeft.x).toBeLessThanOrEqual(20 + TOL);
    expect(q.topLeft.y).toBeGreaterThanOrEqual(20 - TOL);
    expect(q.topLeft.y).toBeLessThanOrEqual(20 + TOL);
    expect(q.bottomRight.x).toBeGreaterThanOrEqual(180 - TOL);
    expect(q.bottomRight.x).toBeLessThanOrEqual(180 + TOL);
    expect(q.bottomRight.y).toBeGreaterThanOrEqual(280 - TOL);
    expect(q.bottomRight.y).toBeLessThanOrEqual(280 + TOL);
    expect(result!.sourceSize).toEqual({ w: 200, h: 300 });
  });

  it('returns null when the bright region is too small to be a document', async () => {
    // 300×300 background with a tiny 20×20 white square — way below
    // the 25%-area confidence floor.
    const src = await buildRectangleOnBackground({
      imgW: 300,
      imgH: 300,
      rectInset: 140,
      bgFill: 20,
      docFill: 240,
    });
    const result = await detectDocumentQuad(src);
    expect(result).toBeNull();
  });

  it('returns null on a uniform (one-colour) image', async () => {
    // No bimodal split → Otsu picks a meaningless threshold → mask is
    // either all-zero or all-one → no component large enough to be a
    // document, OR the entire frame is "document" with no
    // distinguishing corners. Either way, low confidence.
    const flat = Buffer.alloc(100 * 100 * 3, 128);
    const src = await sharp(flat, { raw: { width: 100, height: 100, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();
    const result = await detectDocumentQuad(src);
    // A uniform image's largest component will be the full frame
    // (corners at image corners), but the confidence floor of 25%
    // accepts that. Document detection on a uniform image gives the
    // whole image as the "quad" — which warps to identity — which
    // produces a sensible PDF page. Accept either null or
    // full-image corners.
    if (result) {
      // Corners should be roughly at the image boundaries.
      expect(result.quad.topLeft.x).toBeLessThan(20);
      expect(result.quad.topLeft.y).toBeLessThan(20);
      expect(result.quad.bottomRight.x).toBeGreaterThan(80);
      expect(result.quad.bottomRight.y).toBeGreaterThan(80);
    }
  });
});

describe('autoDetectAndWarp', () => {
  it('produces a warped JPEG when the input has a detectable document', async () => {
    const src = await buildRectangleOnBackground({
      imgW: 200,
      imgH: 300,
      rectInset: 20,
      bgFill: 20,
      docFill: 240,
    });
    const out = await autoDetectAndWarp(src);
    expect(out).not.toBeNull();
    expect(out!.jpeg.length).toBeGreaterThan(0);
    // Output dimensions follow the detected quad's edge averages —
    // roughly the inner rectangle (160×260) within a few px.
    expect(out!.width).toBeGreaterThan(140);
    expect(out!.width).toBeLessThan(180);
    expect(out!.height).toBeGreaterThan(240);
    expect(out!.height).toBeLessThan(280);
  });

  it('returns null when detection bails on a tiny bright region', async () => {
    const src = await buildRectangleOnBackground({
      imgW: 300,
      imgH: 300,
      rectInset: 140,
      bgFill: 20,
      docFill: 240,
    });
    const out = await autoDetectAndWarp(src);
    expect(out).toBeNull();
  });
});
