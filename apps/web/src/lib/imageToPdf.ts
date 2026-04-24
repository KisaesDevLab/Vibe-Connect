// Image-to-PDF helper for the staff web app.
//
// pdf-lib is ~300 KB gzipped and only used when a user actually clicks the
// "save as PDF" action, so we lazy-load it via a singleton promise. This
// mirrors the loadCrypto pattern in state/crypto.tsx so libsodium and
// pdf-lib both stay out of the login/verify bundle.
//
// Format scope: JPEG + PNG only. pdf-lib embeds those natively. WebP / GIF
// / HEIC would need a canvas-conversion step which is deliberately deferred
// — attachments of those types keep the plain image preview + original-
// format download and simply don't show the PDF button.

// Type-only import of the pdf-lib namespace — the runtime import below is
// dynamic so the library's bytes stay out of the first-paint bundle, but
// TypeScript still needs the types at compile time. `import type` makes
// the annotation a compile-only reference.
import type * as PdfLib from 'pdf-lib';

let pdfLibPromise: Promise<typeof PdfLib> | null = null;

async function loadPdfLib(): Promise<typeof PdfLib> {
  if (!pdfLibPromise) pdfLibPromise = import('pdf-lib');
  return pdfLibPromise;
}

/** Gate the UI — only attachments with one of these MIME types get a PDF
 *  button, because pdf-lib's native embed APIs only accept JPEG and PNG. */
export function isPdfConvertible(mimeType: string): boolean {
  return mimeType === 'image/jpeg' || mimeType === 'image/jpg' || mimeType === 'image/png';
}

/**
 * Build a single PDF containing each input image on its own page. Page size
 * matches the image's intrinsic pixel dimensions so no scaling distortion
 * ever occurs. Throws on corrupt or CMYK bytes; callers catch per-image in
 * multi-image flows so one bad attachment doesn't kill the batch.
 */
export async function imagesToPdf(
  images: Array<{ bytes: Uint8Array; mimeType: string }>,
): Promise<Uint8Array> {
  if (images.length === 0) throw new Error('imagesToPdf: no images');
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.create();
  for (const img of images) {
    const embedded =
      img.mimeType === 'image/png'
        ? await doc.embedPng(img.bytes)
        : await doc.embedJpg(img.bytes);
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
