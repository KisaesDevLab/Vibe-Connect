// Distribution mode: SPA-side accessor for the runtime config the server
// emits at /__vibe-boot.js. The script defines window.__VIBE_BOOT__ before
// any of our bundled code runs, so by the time main.tsx imports anything
// the values are already set.
//
// The single source of truth here is `basePath`. URL composition (api.ts
// fetch calls, React Router basename, asset hrefs) all read from this.
// Single-app mode emits an empty string; multi-app emits '/connect' (no
// trailing slash) so concatenation stays unambiguous.

export interface VibeBoot {
  basePath: string;
  siteUrl: string;
  portalUrl: string;
  tlsMode: 'internal' | 'external';
  appName: string | null;
  buildVersion: string;
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
};

/** Returns the runtime config injected by the server, or a safe fallback if
 *  __vibe-boot.js failed to load (e.g. in unit tests or local Vite dev). */
export function getBoot(): VibeBoot {
  if (typeof window === 'undefined') return FALLBACK;
  return window.__VIBE_BOOT__ ?? FALLBACK;
}

/** Prefix-aware URL builder. `path` is always written as if BASE_PATH were
 *  '/' — multi-app mode prepends '/connect' transparently. Leaves absolute
 *  URLs (`http://...`, `//...`) untouched so callers that hand-write a full
 *  URL (the rare cross-origin OIDC redirect, etc.) keep working. */
export function url(path: string): string {
  if (/^[a-z]+:\/\//i.test(path) || path.startsWith('//')) return path;
  const base = getBoot().basePath;
  if (!base) return path.startsWith('/') ? path : '/' + path;
  const p = path.startsWith('/') ? path : '/' + path;
  return base + p;
}
