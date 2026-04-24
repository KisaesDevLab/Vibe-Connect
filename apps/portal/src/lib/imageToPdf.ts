// Image-to-PDF helper for the client portal. Kept in sync with the matching
// file in apps/web/src/lib/imageToPdf.ts — the two apps each bundle their
// own copy rather than sharing a package because the helper is 35 lines.
//
// pdf-lib is lazy-loaded so it never enters the first-paint bundle for the
// portal's login/verify flow. See apps/portal/src/pages/Conversations.tsx
// for the same pattern applied to @vibe-connect/crypto.

// See the matching comment in apps/web/src/lib/imageToPdf.ts — `import type`
// keeps the namespace type available at compile time without pulling the
// runtime bundle into the eager graph.
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
