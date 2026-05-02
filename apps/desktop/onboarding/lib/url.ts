// First-run onboarding URL helpers. Pure functions — no DOM, no Tauri, no
// fetch — so they're vitest-able without a webview.
//
// The firm's appliance lives at a self-chosen domain. We only need three
// guarantees before the desktop commits to it:
//
//   1. The string the user typed is parseable as an absolute URL with
//      a hostname (we tolerate "connect.smithcpa.com" without scheme and
//      default to https).
//   2. In production we refuse plain http (a non-HTTPS appliance leaks
//      session cookies and bridge-sealed plaintext over the wire). The dev
//      override exists so a developer can point at http://localhost:4000.
//   3. The path component is empty or '/'. We don't accept query strings
//      or fragments — the appliance's app shell starts at the root.
//
// Everything here returns a normalized form ('https://host[:port]') with no
// trailing slash so downstream concatenation is unambiguous.

export type NormalizeError =
  | 'empty'
  | 'malformed'
  | 'no_hostname'
  | 'http_in_production'
  | 'unsupported_scheme'
  | 'has_query'
  | 'has_fragment';

export interface NormalizeOk {
  ok: true;
  url: string;
  hostname: string;
  scheme: 'http' | 'https';
}

export interface NormalizeFail {
  ok: false;
  error: NormalizeError;
  detail?: string;
}

export type NormalizeResult = NormalizeOk | NormalizeFail;

/**
 * Normalize a raw user-typed string into a canonical appliance URL.
 *
 * `allowHttp` defaults to false. The desktop callers should leave it false in
 * production builds; tests + a documented dev opt-in pass true so localhost
 * works without TLS. Even with `allowHttp`, we still reject `file:`, `data:`,
 * and other non-http(s) schemes outright.
 */
export function normalizeApplianceUrl(
  raw: string,
  options: { allowHttp?: boolean } = {},
): NormalizeResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'empty' };

  // Decide whether the user typed a bare hostname (default to https://) or a
  // scheme-prefixed URL. We must catch BOTH `scheme://...` AND `scheme:...`
  // forms — `javascript:alert(1)` is the latter and must not be silently
  // re-prefixed with https://. Heuristic: the chars before the first colon
  // are a candidate scheme UNLESS they look like a hostname (contain a dot,
  // are bracketed for IPv6) or what follows the colon looks like a port
  // (digits, then end-of-string or `/`).
  let candidate: string;
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0) {
    candidate = `https://${trimmed}`;
  } else {
    const beforeColon = trimmed.slice(0, colonIdx);
    const afterColon = trimmed.slice(colonIdx + 1);
    const looksLikeHostname = beforeColon.includes('.') || beforeColon.startsWith('[');
    const looksLikePort = /^\d+(?:\/|$)/.test(afterColon);
    if (looksLikeHostname || looksLikePort) {
      candidate = `https://${trimmed}`;
    } else {
      const possibleScheme = beforeColon.toLowerCase();
      if (!/^[a-z][a-z0-9+.-]*$/.test(possibleScheme)) {
        candidate = `https://${trimmed}`;
      } else if (possibleScheme === 'http' || possibleScheme === 'https') {
        candidate = trimmed;
      } else {
        return { ok: false, error: 'unsupported_scheme', detail: possibleScheme };
      }
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: 'malformed' };
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return { ok: false, error: 'unsupported_scheme', detail: scheme };
  }
  if (scheme === 'http' && !options.allowHttp) {
    return { ok: false, error: 'http_in_production' };
  }

  if (!parsed.hostname) return { ok: false, error: 'no_hostname' };

  // We allow a path component because multi-app appliances live under a
  // shared hostname at a sub-path (e.g. `https://shared.host/connect/`,
  // BASE_PATH=/connect). Single-app appliances pass an empty path and the
  // URL parser normalizes that to '/'. Either way we keep what the user
  // typed and let the probe/navigate step append the bootstrap path.
  //
  // We DO reject query strings and fragments — those have no place in an
  // appliance root URL and most likely mean the user pasted a deep link.
  if (parsed.search) return { ok: false, error: 'has_query', detail: parsed.search };
  if (parsed.hash) return { ok: false, error: 'has_fragment', detail: parsed.hash };

  // Drop the trailing slash from the path so callers can do
  // `${url}/__vibe-boot.js` without producing `//__vibe-boot.js`. An
  // empty pathname is normalized to '/' by the URL parser, which we
  // strip back to ''.
  const port = parsed.port ? `:${parsed.port}` : '';
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  const url = `${scheme}://${parsed.hostname}${port}${path}`;

  return { ok: true, url, hostname: parsed.hostname, scheme: scheme as 'http' | 'https' };
}

// ---------- Probe helpers ----------
//
// validateBootScript parses the body of `${url}/__vibe-boot.js` and decides
// whether the response actually came from a Vibe Connect server. Returning a
// discriminated union makes error UX trivial: each branch has a known
// presentation.

export type ProbeError =
  | 'not_a_vibe_server' // body didn't include the bootstrap marker
  | 'invalid_json' // bootstrap line was unparseable
  | 'wrong_shape'; // JSON parsed but missing required keys

export interface ProbeOk {
  ok: true;
  basePath: string;
  tlsMode: 'internal' | 'external';
  appName: string | null;
  buildVersion: string;
}

export interface ProbeFail {
  ok: false;
  error: ProbeError;
  detail?: string;
}

export type ProbeResult = ProbeOk | ProbeFail;

const BOOT_PREFIX = 'window.__VIBE_BOOT__';

/**
 * Pull the JSON object out of a `window.__VIBE_BOOT__ = {...};` line. The
 * server always emits exactly one assignment terminated by `;\n`, so a
 * regex-free split is sufficient and easier to reason about than a JS parser.
 *
 * Returns the parsed object or one of the discriminated error codes.
 */
export function validateBootScript(body: string): ProbeResult {
  if (!body.includes(BOOT_PREFIX)) {
    return { ok: false, error: 'not_a_vibe_server' };
  }
  const equalsIdx = body.indexOf('=', body.indexOf(BOOT_PREFIX));
  if (equalsIdx < 0) return { ok: false, error: 'invalid_json' };

  // The trailing `;` may or may not be on the same line. Find the LAST `}`
  // before the next `;` so we tolerate pretty-printed responses without
  // taking a dependency on a JS parser.
  const tail = body.slice(equalsIdx + 1);
  const semicolonIdx = tail.lastIndexOf(';');
  if (semicolonIdx < 0) return { ok: false, error: 'invalid_json' };
  const jsonRegion = tail.slice(0, semicolonIdx).trim();
  if (!jsonRegion.startsWith('{') || !jsonRegion.endsWith('}')) {
    return { ok: false, error: 'invalid_json' };
  }

  let obj: unknown;
  try {
    obj = JSON.parse(jsonRegion);
  } catch (err) {
    return {
      ok: false,
      error: 'invalid_json',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'wrong_shape' };
  }
  const o = obj as Record<string, unknown>;
  const basePath = typeof o.basePath === 'string' ? o.basePath : null;
  const tlsMode = o.tlsMode === 'internal' || o.tlsMode === 'external' ? o.tlsMode : null;
  const buildVersion = typeof o.buildVersion === 'string' ? o.buildVersion : null;
  if (basePath === null || tlsMode === null || buildVersion === null) {
    return { ok: false, error: 'wrong_shape' };
  }
  const appName = typeof o.appName === 'string' ? o.appName : null;

  return { ok: true, basePath, tlsMode, appName, buildVersion };
}

/**
 * The user-facing label for each error. Kept here (not in the HTML) so the
 * tests can pin the contract.
 */
export function describeNormalizeError(err: NormalizeError, detail?: string): string {
  switch (err) {
    case 'empty':
      return 'Enter your firm’s Vibe Connect URL.';
    case 'malformed':
      return 'That URL doesn’t look right. Try “https://connect.yourfirm.com”.';
    case 'no_hostname':
      return 'The URL is missing a hostname.';
    case 'http_in_production':
      return 'Vibe Connect requires HTTPS. Ask your admin for the secure URL.';
    case 'unsupported_scheme':
      return `Only http(s) is supported (got “${detail ?? 'unknown'}”).`;
    case 'has_query':
      return 'The URL shouldn’t include a query string.';
    case 'has_fragment':
      return 'The URL shouldn’t include a fragment.';
  }
}

export function describeProbeError(err: ProbeError): string {
  switch (err) {
    case 'not_a_vibe_server':
      return 'That server didn’t identify itself as Vibe Connect.';
    case 'invalid_json':
      return 'The server replied, but the bootstrap script wasn’t parseable.';
    case 'wrong_shape':
      return 'The bootstrap script is missing required fields.';
  }
}
