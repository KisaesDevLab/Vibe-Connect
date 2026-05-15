// Phase 28.7 — ambient module declaration for `jscanify`.
//
// jscanify v1.0.0 ships as a UMD bundle with no .d.ts. We use one method
// from it (`getCornerPoints`) and only when `window.cv` (OpenCV.js) is
// already loaded on the page. The signature here is a tight subset — the
// real library exposes more (highlightPaper, extractPaper, etc.) but if
// we ever consume them we'll add them here.
declare module 'jscanify' {
  export interface JscanifyCornerPoints {
    topLeftCorner: { x: number; y: number };
    topRightCorner: { x: number; y: number };
    bottomLeftCorner: { x: number; y: number };
    bottomRightCorner: { x: number; y: number };
  }
  export default class Jscanify {
    constructor();
    getCornerPoints(img: HTMLImageElement | HTMLCanvasElement): JscanifyCornerPoints;
  }
}
