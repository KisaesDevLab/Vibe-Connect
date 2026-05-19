// Distribution mode: SPA-side accessor for the runtime config the server
// emits at /__vibe-boot.js. See apps/web/src/lib/boot.ts for the full
// rationale — this is the portal mirror.

export interface VibeBoot {
  basePath: string;
  siteUrl: string;
  portalUrl: string;
  tlsMode: 'internal' | 'external';
  appName: string | null;
  buildVersion: string;
  turnstileSiteKey: string | null;
}

declare global {
  interface Window {
    __VIBE_BOOT__?: VibeBoot;
  }
}

const FALLBACK: VibeBoot = {
  basePath: '',
  siteUrl: '',
  portalUrl: '',
  tlsMode: 'internal',
  appName: null,
  buildVersion: 'dev',
  turnstileSiteKey: null,
};

export function getBoot(): VibeBoot {
  if (typeof window === 'undefined') return FALLBACK;
  return window.__VIBE_BOOT__ ?? FALLBACK;
}

export function url(path: string): string {
  if (/^[a-z]+:\/\//i.test(path) || path.startsWith('//')) return path;
  const base = getBoot().basePath;
  // `base === '/'` collapses to the root-mount case: `base + '/api/foo'`
  // would otherwise emit `//api/foo`, which a browser parses as a
  // protocol-relative URL. Defensive guard alongside the server-side
  // bootstrap fix that now emits `""` instead of `"/"`.
  if (!base || base === '/') return path.startsWith('/') ? path : '/' + path;
  const p = path.startsWith('/') ? path : '/' + path;
  return base + p;
}
