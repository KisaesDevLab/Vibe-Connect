// Image-to-PDF helper for the staff web app.
//
// pdf-lib is ~300 KB gzipped and only used when a user actually clicks the
// "save as PDF" action, so we lazy-load it via a singleton promise.
//
// Format support:
//   - JPEG, PNG: embedded natively by pdf-lib (`embedJpg` / `embedPng`)
//   - WebP, GIF: decoded by the browser via <img>, redrawn to a <canvas>,
//     re-exported as PNG bytes, then embedded. Animated GIF: first frame
//     only (whichever frame the browser presents when we draw).
//   - HEIC, HEIF: blocked behind the optional `heic2any` dep. When the
//     module is installed the import resolves and HEIC works; without it
//     the click surfaces a clear error message instead of crashing.
//     Install with: yarn workspace @vibe-connect/web add heic2any
import type * as PdfLib from 'pdf-lib';

let pdfLibPromise: Promise<typeof PdfLib> | null = null;
async function loadPdfLib(): Promise<typeof PdfLib> {
  if (!pdfLibPromise) pdfLibPromise = import('pdf-lib');
  return pdfLibPromise;
}

const NATIVE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png']);
const CANVAS_DECODABLE_MIMES = new Set(['image/webp', 'image/gif']);
const HEIC_MIMES = new Set(['image/heic', 'image/heif']);

/** Gate the UI — every mime we know how to PDF-ify (with or without
 *  optional deps loaded) returns true. The actual conversion path is
 *  decided inside `imagesToPdf`. */
export function isPdfConvertible(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return NATIVE_MIMES.has(m) || CANVAS_DECODABLE_MIMES.has(m) || HEIC_MIMES.has(m);
}

/**
 * Decode an image the browser can render natively (JPEG/PNG/WebP/GIF) and
 * return PNG bytes via canvas re-encode. PNG is lossless so re-export
 * doesn't lose receipt detail; we deliberately don't go via JPEG because
 * an already-compressed source would double-pay the lossy DCT. Only the
 * first frame of an animated GIF is captured (canvas drawImage paints
 * whatever frame the browser is showing at that moment).
 */
async function imageToPngBytes(bytes: Uint8Array, mimeType: string): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`failed to decode ${mimeType}`));
      el.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas_2d_unsupported');
    ctx.drawImage(img, 0, 0);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!out) throw new Error('canvas_toBlob_failed');
    const buf = await out.arrayBuffer();
    return new Uint8Array(buf);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * HEIC → JPEG via the optional `heic2any` library. The dep is large
 * (~500 KB gzipped) and only relevant on iPhone-photo workflows, so it's
 * lazy-imported and gracefully missing — the catch surfaces the install
 * hint instead of blowing up the whole conversion.
 */
async function heicToJpegBytes(bytes: Uint8Array): Promise<Uint8Array> {
  // The import is typed via the ambient `declare module 'heic2any'` in
  // src/optional-deps.d.ts. The /* @vite-ignore */ comment + dynamic
  // string keeps Rollup from trying to statically resolve the module at
  // bundle time — without this, vite hard-errors at build time when
  // `heic2any` isn't installed. The runtime catch handles missing-dep.
  let mod: {
    default?: (opts: { blob: Blob; toType: string; quality?: number }) => Promise<Blob | Blob[]>;
  };
  try {
    const heicModuleName = 'heic2any';
    mod = (await import(/* @vite-ignore */ heicModuleName)) as typeof mod;
  } catch {
    throw new Error(
      "HEIC support requires the 'heic2any' module. Install it with: yarn workspace @vibe-connect/web add heic2any",
    );
  }
  const fn = mod.default;
  if (!fn) throw new Error('heic2any module loaded but missing default export');
  const blob = new Blob([bytes as BlobPart], { type: 'image/heic' });
  const out = await fn({ blob, toType: 'image/jpeg', quality: 0.92 });
  const single = Array.isArray(out) ? out[0]! : out;
  const buf = await single.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Build a single PDF containing each input image on its own page. Page
 * size matches the image's intrinsic pixel dimensions so no scaling
 * distortion ever occurs. Throws on corrupt bytes; callers catch per-
 * image in multi-image flows so one bad attachment doesn't kill the
 * batch.
 */
export async function imagesToPdf(
  images: Array<{ bytes: Uint8Array; mimeType: string }>,
): Promise<Uint8Array> {
  if (images.length === 0) throw new Error('imagesToPdf: no images');
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.create();
  for (const img of images) {
    const mime = img.mimeType.toLowerCase();
    let embedded;
    if (mime === 'image/png') {
      embedded = await doc.embedPng(img.bytes);
    } else if (mime === 'image/jpeg' || mime === 'image/jpg') {
      embedded = await doc.embedJpg(img.bytes);
    } else if (CANVAS_DECODABLE_MIMES.has(mime)) {
      const png = await imageToPngBytes(img.bytes, mime);
      embedded = await doc.embedPng(png);
    } else if (HEIC_MIMES.has(mime)) {
      const jpeg = await heicToJpegBytes(img.bytes);
      embedded = await doc.embedJpg(jpeg);
    } else {
      throw new Error(`unsupported_mime: ${mime}`);
    }
    const page = doc.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: embedded.width,
      height: embedded.height,
    });
  }
  return doc.save();
}
