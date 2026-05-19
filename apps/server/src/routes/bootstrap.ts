// Distribution mode: serves a small JS file the SPAs load BEFORE their own
// bundle so they know which BASE_PATH to mount under. The same compiled
// bundle works in single-app mode (BASE_PATH='/') and multi-app mode
// (BASE_PATH='/connect') without rebuild.
//
// Public — no auth required. Returns only values that are safe for an
// unauthenticated browser to read: paths/URLs the operator already exposes
// via DNS, plus the firm-settable display name. NEVER include secrets,
// per-user data, firm configuration not already public, or anything that
// could let a probing attacker fingerprint the deploy.
//
// The output is JS (not JSON) so it can be loaded as a classic <script>
// tag without the SPA having to await a fetch before it knows its own
// base path. That avoids a flash-of-wrong-routing on first paint.
import { Router, type Request } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { effectiveUrls, type EffectiveUrls } from '../services/effectiveUrls.js';

export const bootstrapRouter = Router();

/**
 * Pick the basePath the requesting SPA should mount its router under.
 *
 * Multi-subdomain appliance deployments serve the staff bundle at one host
 * (vibe.<domain>/connect/, basePath="/connect") AND the client portal at
 * another (client.<domain>/, basePath="/"). The SAME server emits the
 * boot script for both — so a single env.basePath value is wrong for one
 * of them. Match the request's Host against the effective portal/site
 * URLs and derive basePath from whichever URL's pathname matches.
 *
 * Single-app deployments and dev environments where Host matches neither
 * URL (e.g. localhost:4000 hitting the endpoint directly during a test)
 * fall back to env.basePath — preserving the prior behavior.
 *
 * Why URL.pathname instead of a separate env var: the SPA's basePath is
 * already encoded in the URL the operator gave it. SITE_URL / PORTAL_URL
 * are configurable via firm_settings DB overrides AND env vars; deriving
 * from those makes the operator the single source of truth and avoids a
 * "set BASE_PATH and SITE_URL to consistent values, or weird things happen"
 * footgun.
 */
function basePathForRequest(req: Request, urls: EffectiveUrls): string {
  const reqHost = req.get('host');
  if (!reqHost) return env.basePath;
  // Portal first: the typical "blank page" failure mode this fixes is the
  // portal SPA receiving the staff basePath, not the other way around.
  // Matching against the explicit portalUrl override before siteUrl
  // ensures it wins even if an operator accidentally configures
  // overlapping hosts.
  for (const url of [urls.portalUrl, urls.siteUrl]) {
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.host === reqHost) {
        // URL.pathname for a hostname-only URL is "/" — strip the trailing
        // slash so the SPA's router gets a consistent shape: "" for the
        // root-mounted case and "/connect" (no trailing slash) for the
        // prefixed case. MUST NOT fall back to "/" when the strip leaves
        // an empty string — the SPA's url() helper does `base + path` and
        // would emit "/" + "/api/foo" = "//api/foo", which a browser
        // interprets as a protocol-relative URL with `api` as the host.
        // Empty string is the right value here; React Router accepts it
        // as a basename and `url()` short-circuits on falsy base.
        return parsed.pathname.replace(/\/$/, '');
      }
    } catch {
      // Malformed URL in env or DB — skip this candidate and try the next.
    }
  }
  return env.basePath;
}

interface VibeBoot {
  basePath: string;
  siteUrl: string;
  portalUrl: string;
  tlsMode: 'internal' | 'external';
  appName: string | null;
  buildVersion: string;
  // Phase 28.4 — Cloudflare Turnstile site key for the anonymous intake
  // form. Null when Turnstile isn't configured; the SPA renders no widget
  // and the server accepts submissions without a token. Site keys are
  // public by design; the matching secret key stays in env.turnstileSecretKey.
  turnstileSiteKey: string | null;
}

// JSON.stringify alone doesn't escape `</script>` or U+2028 / U+2029 in
// string values. Today this endpoint is loaded as <script src="..."> so the
// browser parses the response in a JS context where '</script>' is a literal
// — no HTML parser bailout. But appName is admin-mutable and the SPA's
// nginx-served index.html runs through sub_filter; a future refactor that
// inlines this script content into HTML would make raw '</script>' an XSS
// vector. Defense in depth: escape the three characters that matter so the
// payload stays safe in any serialization context.
//
// String-form replaceAll() (not regex) so esbuild's parser doesn't choke on
// raw U+2028 / U+2029 in the source.
const U_2028 = String.fromCharCode(0x2028);
const U_2029 = String.fromCharCode(0x2029);

function safeStringify(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll(U_2028, '\\u2028')
    .replaceAll(U_2029, '\\u2029');
}

bootstrapRouter.get(
  '/__vibe-boot.js',
  asyncHandler(async (req, res) => {
    let appName: string | null = null;
    try {
      const row = await db('firm_settings').where({ id: 1 }).first('app_name');
      const raw = (row?.app_name as string | null | undefined) ?? null;
      appName = raw && raw.trim() ? raw.trim() : null;
    } catch {
      // Pre-migration boot or DB outage — fall through with appName=null so
      // the SPA still bootstraps and shows the default branding.
      appName = null;
    }
    // siteUrl/portalUrl honor the DB-side admin override (firm_settings.site_url,
    // firm_settings.portal_url) when set; otherwise fall back to env vars.
    // Same 60s cache-control window on this response means an admin save
    // propagates to all SPAs within a minute.
    const urls = await effectiveUrls();
    const boot: VibeBoot = {
      // Host-aware basePath: portal vs staff get different prefixes when
      // they live on different subdomains. See basePathForRequest() for
      // why this can't be a single env.basePath value.
      basePath: basePathForRequest(req, urls),
      siteUrl: urls.siteUrl,
      portalUrl: urls.portalUrl,
      tlsMode: env.tlsMode,
      appName,
      buildVersion: env.buildVersion,
      // Only surface the site key when BOTH halves are configured. A
      // half-configured Turnstile (site set, secret blank, or vice versa)
      // would leave the SPA rendering a widget that fails verification on
      // the server side — better to silently disable until both land.
      turnstileSiteKey:
        env.turnstileSiteKey && env.turnstileSecretKey ? env.turnstileSiteKey : null,
    };
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    // 60s revalidation: long enough that tab-switching / soft refreshes don't
    // burn rate-limit budget; short enough that an admin renaming the app
    // (PATCH /admin/settings) sees the update propagate to all clients within
    // a minute without forcing a hard reload.
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    res.send(`window.__VIBE_BOOT__ = ${safeStringify(boot)};\n`);
  }),
);
