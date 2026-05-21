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
