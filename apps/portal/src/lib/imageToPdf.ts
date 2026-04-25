// Image-to-PDF helper for the client portal. Kept in sync with the matching
// file in apps/web/src/lib/imageToPdf.ts — the two apps each bundle their
// own copy rather than sharing a package.
//
// Format support:
//   - JPEG, PNG: embedded natively by pdf-lib
//   - WebP, GIF: decoded by the browser via <img>, redrawn to a <canvas>,
//     re-exported as PNG bytes, then embedded. Animated GIF: first frame.
//   - HEIC, HEIF: blocked behind the optional `heic2any` dep. Install with:
//     yarn workspace @vibe-connect/portal add heic2any
//
// pdf-lib + heic2any are both lazy-imported so neither lands in the
// login/verify bundle.
import type * as PdfLib from 'pdf-lib';

let pdfLibPromise: Promise<typeof PdfLib> | null = null;
async function loadPdfLib(): Promise<typeof PdfLib> {
  if (!pdfLibPromise) pdfLibPromise = import('pdf-lib');
  return pdfLibPromise;
}

const NATIVE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png']);
const CANVAS_DECODABLE_MIMES = new Set(['image/webp', 'image/gif']);
const HEIC_MIMES = new Set(['image/heic', 'image/heif']);

export function isPdfConvertible(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return NATIVE_MIMES.has(m) || CANVAS_DECODABLE_MIMES.has(m) || HEIC_MIMES.has(m);
}

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
    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!out) throw new Error('canvas_toBlob_failed');
    const buf = await out.arrayBuffer();
    return new Uint8Array(buf);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function heicToJpegBytes(bytes: Uint8Array): Promise<Uint8Array> {
  // /* @vite-ignore */ + dynamic string keeps Rollup from trying to
  // statically resolve the optional dep at bundle time. Runtime catch
  // surfaces the install hint when the dep is genuinely missing.
  let mod: { default?: (opts: { blob: Blob; toType: string; quality?: number }) => Promise<Blob | Blob[]> };
  try {
    const heicModuleName = 'heic2any';
    mod = (await import(/* @vite-ignore */ heicModuleName)) as typeof mod;
  } catch {
    throw new Error(
      "HEIC support requires the 'heic2any' module. Install it with: yarn workspace @vibe-connect/portal add heic2any",
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
