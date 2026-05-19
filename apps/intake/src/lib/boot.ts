// Distribution mode: SPA-side accessor for the runtime config the server
// emits at /__vibe-boot.js. The same image runs single-app and multi-app —
// nginx's sub_filter rewrites the `<base href>` placeholder in index.html
// at request time; the SPA reads BASE_PATH back from window.__VIBE_BOOT__
// and prepends it to every fetch + uses it as the React Router basename.
// Mirror of apps/web/src/lib/boot.ts and apps/portal/src/lib/boot.ts.

export interface VibeBoot {
  basePath: string;
  siteUrl: string;
  portalUrl: string;
  tlsMode: 'internal' | 'external';
  appName: string | null;
  buildVersion: string;
  // Phase 28.4 — Cloudflare Turnstile site key for the anonymous intake
  // form. Null when Turnstile is unconfigured on the appliance; the SPA
  // then renders no widget and the server accepts submissions without a
  // token. Authoritative source is apps/server/src/routes/bootstrap.ts.
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

/**
 * Prefix a path with the runtime BASE_PATH. Absolute URLs pass through
 * untouched. Used by every fetch in this SPA so a single bundle runs
 * under both '/' and '/connect/' prefixes without rebuild.
 */
export function url(path: string): string {
  if (/^[a-z]+:\/\//i.test(path) || path.startsWith('//')) return path;
  const base = getBoot().basePath;
  // `base === '/'` collapses to the root-mount case: `base + '/api/foo'`
  // would otherwise emit `//api/foo`, which a browser parses as a
  // protocol-relative URL and tries to DNS-resolve `api`. Defensive
  // belt-and-suspenders against an older server returning `/` for the
  // root-mount basePath (the bootstrap was changed to emit `""` instead,
  // but this SPA may be served from a stale appliance).
  if (!base || base === '/') return path.startsWith('/') ? path : '/' + path;
  const p = path.startsWith('/') ? path : '/' + path;
  return base + p;
}
