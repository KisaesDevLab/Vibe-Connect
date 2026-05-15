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
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { db } from '../db/knex.js';
import { env } from '../env.js';

export const bootstrapRouter = Router();

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
  asyncHandler(async (_req, res) => {
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
    const boot: VibeBoot = {
      basePath: env.basePath,
      siteUrl: env.siteUrl,
      portalUrl: env.portalUrl,
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
