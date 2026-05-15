import 'dotenv/config';

function str(key: string, def?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (def !== undefined) return def;
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function num(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Invalid numeric env: ${key}=${v}`);
  return n;
}

function bool(key: string, def: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return v === '1' || v.toLowerCase() === 'true';
}

/**
 * Reads an env var that must be one of a fixed set of strings. Used by the
 * distribution-mode knobs where a typo would silently fall through to the
 * default and produce wrong cookie scopes / ACME state.
 */
function oneOf<T extends string>(key: string, allowed: readonly T[], def: T): T {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`Invalid ${key}=${v}; expected one of ${allowed.join(', ')}`);
  }
  return v as T;
}

/**
 * Parse a CORS allow-list. Comma-separated. Each entry is either a literal
 * origin (e.g. `https://connect.firm.com`) or `regex:<pattern>` for a
 * RegExp match. Empty list = unset = caller falls through to the legacy
 * reflect-origin behavior.
 *
 * Why both literals and regex: appliance customers usually have one or two
 * known FQDNs (literal is safer); but on-prem deploys with rotating
 * sub-tenant subdomains (e.g. `*.firm-internal.local`) need a pattern.
 * Regex is opt-in per-entry so a typo in a literal can't accidentally
 * become a permissive regex.
 */
type OriginRule = { kind: 'literal'; value: string } | { kind: 'regex'; value: RegExp };
function parseAllowedOrigin(): OriginRule[] {
  const raw = process.env.ALLOWED_ORIGIN;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      if (entry.startsWith('regex:')) {
        const pat = entry.slice('regex:'.length);
        try {
          return { kind: 'regex' as const, value: new RegExp(pat) };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Invalid regex in ALLOWED_ORIGIN: ${pat} — ${msg}`);
        }
      }
      return { kind: 'literal' as const, value: entry };
    });
}

const isProd = process.env.NODE_ENV === 'production';

export const env = {
  nodeEnv: (process.env.NODE_ENV ?? 'development') as 'development' | 'test' | 'production',
  isProd,
  port: num('PORT', 4000),
  // Distribution-shaped defaults: image-default URL is the app's own port.
  // Daily dev work via `yarn dev` runs the SPAs on :5173/:5174 and overrides
  // SITE_URL/PORTAL_URL via the local .env file. The defaults baked into the
  // image match the prod-single-app shape so an operator's `docker compose up`
  // produces working URLs without per-knob tweaking.
  siteUrl: str('SITE_URL', 'http://localhost:4000'),
  portalUrl: str('PORTAL_URL', 'http://localhost:4000/portal'),
  apiUrl: str('API_URL', 'http://localhost:4000'),

  // Distribution mode knobs (see vibe-distribution-plan.md). The same image
  // runs in both single-app and multi-app modes — every per-mode value lives
  // here, never in the build.
  //   single-app : BASE_PATH=/, SESSION_COOKIE_PATH=/, TLS_MODE=internal
  //   multi-app  : BASE_PATH=/connect, SESSION_COOKIE_PATH=/connect, TLS_MODE=external
  // Stored without trailing slash to keep cookie path + URL composition
  // unambiguous; the bootstrap route adds the trailing slash for <base href>.
  basePath: (() => {
    const raw = str('BASE_PATH', '/');
    if (raw === '/') return '';
    return raw.replace(/\/+$/, '');
  })(),
  sessionCookiePath: str('SESSION_COOKIE_PATH', '/'),
  // 'internal' keeps the in-app ACME ticker + admin endpoints active (Phase 23
  // single-appliance deploys). 'external' disables them so an upstream Caddy
  // / Cloudflare Tunnel terminates TLS without two managers fighting for :80.
  // The /.well-known/acme-challenge responder stays mounted in both modes.
  tlsMode: oneOf('TLS_MODE', ['internal', 'external'] as const, 'internal'),
  // Build version surfaced to the SPA via /__vibe-boot.js. Set by the release
  // pipeline (image build args), defaults to 'dev' for local containers.
  buildVersion: str('BUILD_VERSION', 'dev'),

  // Optional CORS allow-list. Empty = legacy reflect-origin behavior (the
  // default appliance shape, where SameSite=lax + session checks gate writes
  // and CORS is only used to keep XHR errors quiet). Set this in deployments
  // where you want explicit CORS enforcement — e.g. when the appliance is
  // reachable from a marketing site or a third-party portal that should NOT
  // be allowed to issue credentialed XHRs against the API.
  allowedOrigin: parseAllowedOrigin(),

  databaseUrl: str('DATABASE_URL', 'postgres://vibe:vibe@localhost:5435/vibe_connect'),
  testDatabaseUrl: str(
    'TEST_DATABASE_URL',
    'postgres://vibe:vibe@localhost:5435/vibe_connect_test',
  ),

  sessionSecret: str('SESSION_SECRET', isProd ? '' : 'dev-only-change-me-insecure-session-secret'),
  sessionCookieName: str('SESSION_COOKIE_NAME', 'vibe.sid'),
  sessionSecure: bool('SESSION_SECURE', isProd),
  sessionSameSite: str('SESSION_SAMESITE', 'lax') as 'lax' | 'strict' | 'none',

  attachmentDriver: str('ATTACHMENT_DRIVER', 'local') as 'local' | 's3',
  attachmentLocalDir: str('ATTACHMENT_LOCAL_DIR', './infra/docker/uploads'),
  attachmentMaxBytes: num('ATTACHMENT_MAX_BYTES', 100 * 1024 * 1024),
  s3Bucket: str('S3_BUCKET', ''),
  s3Region: str('S3_REGION', ''),
  s3AccessKeyId: str('S3_ACCESS_KEY_ID', ''),
  s3SecretAccessKey: str('S3_SECRET_ACCESS_KEY', ''),
  s3Endpoint: str('S3_ENDPOINT', ''),
  // Self-hosted MinIO / on-prem S3-compatible installs legitimately point at
  // LAN hostnames. Literal private IPs in S3_ENDPOINT are treated as
  // suspicious (they're a common SSRF-via-config footgun) unless the
  // operator explicitly opts in by setting this flag.
  s3AllowPrivateEndpoint: bool('S3_ALLOW_PRIVATE_ENDPOINT', false),

  // 'none' is an explicit "no email" configuration: every send call returns
  // success without dispatching. Use it on appliance deployments that
  // don't have outbound mail configured yet (the portal's access-code flow
  // will keep working since SMS can carry the code, and the same /identify
  // response shape is preserved so the absence isn't probe-able). The
  // db-backed `firm_settings.email_provider` enum doesn't include 'none'
  // — flipping the override here is the only way to disable mail wholesale.
  emailProvider: str('EMAIL_PROVIDER', 'mock') as 'mock' | 'postmark' | 'postfix' | 'none',
  emailFrom: str('EMAIL_FROM', 'Vibe Connect <noreply@vibeconnect.local>'),
  emailInboundDomain: str('EMAIL_INBOUND_DOMAIN', 'connect.vibeconnect.local'),
  postmarkServerToken: str('POSTMARK_SERVER_TOKEN', ''),
  postmarkInboundWebhookSecret: str('POSTMARK_INBOUND_WEBHOOK_SECRET', ''),
  // Dedicated secret for the Postfix pipe's raw-MIME endpoint. Previously
  // this shared POSTMARK_INBOUND_WEBHOOK_SECRET, which meant a leaked
  // Postmark bounce/error revealing the secret also opened the raw endpoint.
  // Defaults to the Postmark secret for backwards compatibility — operators
  // upgrading should rotate this separately and then rotate Postmark's.
  postfixRawBridgeSecret: str(
    'POSTFIX_RAW_BRIDGE_SECRET',
    process.env.POSTMARK_INBOUND_WEBHOOK_SECRET ?? '',
  ),

  smsProvider: str('SMS_PROVIDER', 'mock') as 'mock' | 'textlink' | 'twilio',
  textlinkApiKey: str('TEXTLINK_API_KEY', ''),
  textlinkWebhookSecret: str('TEXTLINK_WEBHOOK_SECRET', ''),
  twilioAccountSid: str('TWILIO_ACCOUNT_SID', ''),
  twilioAuthToken: str('TWILIO_AUTH_TOKEN', ''),
  twilioFromNumber: str('TWILIO_FROM_NUMBER', ''),
  twilioMessagingServiceSid: str('TWILIO_MESSAGING_SERVICE_SID', ''),

  vapidPublicKey: str('VAPID_PUBLIC_KEY', ''),
  vapidPrivateKey: str('VAPID_PRIVATE_KEY', ''),
  vapidSubject: str('VAPID_SUBJECT', 'mailto:admin@vibeconnect.local'),

  rateLimitLoginPerMin: num('RATE_LIMIT_LOGIN_PER_MIN', 5),
  rateLimitPortalCodePer10Min: num('RATE_LIMIT_PORTAL_CODE_PER_10MIN', 3),
  rateLimitGlobalPerMin: num('RATE_LIMIT_GLOBAL_PER_MIN', 600),
  // Phase 28.4 — anonymous intake submissions per IP per 15 min. Default
  // matches the build plan (5). Tests override to a large number so they
  // don't exhaust the budget in a single suite.
  rateLimitIntakeSessionPer15Min: num('RATE_LIMIT_INTAKE_SESSION_PER_15MIN', 5),
  // Bridge-inbound limiters. Shared-secret webhook auth already keeps random
  // callers out, but a misconfigured provider or leaked secret could flood
  // the appliance. These cap the surge per source IP.
  rateLimitEmailInboundPerMin: num('RATE_LIMIT_EMAIL_INBOUND_PER_MIN', 200),
  rateLimitSmsInboundPerMin: num('RATE_LIMIT_SMS_INBOUND_PER_MIN', 500),

  stepupDefaultTimeoutHours: num('STEPUP_DEFAULT_TIMEOUT_HOURS', 24),

  outboxDir: str('OUTBOX_DIR', './.outbox'),

  clamdHost: str('CLAMD_HOST', ''),
  clamdPort: num('CLAMD_PORT', 3310),

  // Phase 28 — Vibe File Transfer (Intake).
  //
  // 32-byte libsodium secretbox key in base64 form (i.e. 44 chars). Used by
  // services/intakeCrypto.ts to seal every intake field (PII columns) and
  // file body on disk. Distinct from SESSION_SECRET per ADR-028: rotating
  // the intake key via the Phase 28.16 admin route must NOT invalidate
  // user sessions, sealed provider creds, or ACME state — and rotating
  // SESSION_SECRET must NOT silently re-key every intake blob.
  //
  // Empty in dev = intakeCrypto throws on first encrypt call; intake
  // routes aren't mounted until 28.4 anyway so the boot path stays green.
  // Production enforcement lives in intakeCrypto.ts at first use.
  connectIntakeEncryptionKey: str('CONNECT_INTAKE_ENCRYPTION_KEY', ''),

  // Phase 28.16 — Intake key rotation. Set this alongside the existing
  // CONNECT_INTAKE_ENCRYPTION_KEY for the duration of a rotation run; the
  // `/admin/intake/rotate-key` worker reads both, decrypts every row with
  // the old key, re-encrypts with the new key, and persists progress to
  // `intake_key_rotations`. After completion the operator swaps env vars
  // (the new key becomes the current `CONNECT_INTAKE_ENCRYPTION_KEY` and
  // this var is removed) and restarts. While both vars are set in dev,
  // intake at-rest reads continue against the OLD key (current); the NEW
  // key is reachable only via the rotation worker.
  connectIntakeEncryptionKeyNew: str('CONNECT_INTAKE_ENCRYPTION_KEY_NEW', ''),

  // Phase 28.4 — Optional Cloudflare Turnstile keys for the anonymous
  // intake form (POST /api/public/intake/sessions). Both keys must be set
  // for Turnstile to engage; the SITE key is exposed to the public SPA via
  // window.__VIBE_BOOT__, the SECRET key stays server-side for the verify
  // round-trip against challenges.cloudflare.com. Leave both blank to
  // disable Turnstile (the route then accepts submissions without a token).
  turnstileSiteKey: str('TURNSTILE_SITE_KEY', ''),
  turnstileSecretKey: str('TURNSTILE_SECRET_KEY', ''),
  // Fail-safe override. When CLAMD_HOST is empty, scanBuffer() returns 'clean'
  // as a documented dev fallback. In production that means every attachment
  // ships unscanned. An operator who genuinely wants that (e.g., an isolated
  // network with no malware threat) must set ALLOW_UNSCANNED_UPLOADS=1
  // explicitly; the boot check below refuses to start otherwise.
  allowUnscannedUploads: bool('ALLOW_UNSCANNED_UPLOADS', false),

  smtpHost: str('SMTP_HOST', ''),
  smtpPort: num('SMTP_PORT', 587),
  smtpUser: str('SMTP_USER', ''),
  smtpPass: str('SMTP_PASS', ''),
  smtpSecure: bool('SMTP_SECURE', false),

  oidcIssuerUrl: str('OIDC_ISSUER_URL', ''),
  oidcClientId: str('OIDC_CLIENT_ID', ''),
  oidcClientSecret: str('OIDC_CLIENT_SECRET', ''),
  oidcRedirectUri: str('OIDC_REDIRECT_URI', ''),
  oidcScopes: str('OIDC_SCOPES', 'openid email profile'),
  oidcAdminClaim: str('OIDC_ADMIN_CLAIM', ''),
  oidcAdminClaimValue: str('OIDC_ADMIN_CLAIM_VALUE', ''),

  // Backup-criticality enforcement. Default `false` (standalone) leaves
  // every code path unchanged for self-managed installs. Set to `true` in
  // the appliance overlay where Duplicati is expected to POST to
  // /admin/backup-heartbeat after each successful run; the server then
  // surfaces a banner via /admin/key-status when no successful heartbeat
  // arrives in BACKUP_WARN_DAYS (warn) or BACKUP_BLOCK_DAYS (refuse new
  // vault uploads — existing data still readable).
  backupRequired: bool('BACKUP_REQUIRED', false),
  backupWarnDays: num('BACKUP_WARN_DAYS', 7),
  backupBlockDays: num('BACKUP_BLOCK_DAYS', 30),
  // Bearer token Duplicati (or any backup tool) uses to authenticate to
  // /admin/backup-heartbeat. Empty string disables the endpoint — Duplicati
  // would have to be misconfigured to call an empty-token endpoint, but the
  // gate hard-fails authentication anyway. Length-checked for at least
  // 32 chars (entropy floor) when BACKUP_REQUIRED is on; see the assertion
  // block at the bottom of this file.
  backupHeartbeatToken: str('BACKUP_HEARTBEAT_TOKEN', ''),
  // tus partial-upload cleanup. Default 24h matches the previously
  // hardcoded UPLOAD_TTL_SECONDS so existing installs keep the same
  // disk-reclaim cadence after upgrade. Set higher (e.g. 168 for 7
  // days) on appliances where upload resumes routinely span days
  // because clients work over flaky tethered connections — the disk
  // cost is bounded by ATTACHMENT_MAX_BYTES per parked upload.
  // Disk-only impact; lowering does not lose finished uploads (those
  // are moved out of tus-incoming into the durable store on finalize).
  tusOrphanTtlHours: num('TUS_ORPHAN_TTL_HOURS', 24),
  // Override target for the staff app's `/desktop/` redirect. Defaults to
  // GitHub releases; pin to an internal mirror if the appliance can't
  // reach github.com. The redirect itself is in the nginx config; this
  // value is plumbed through there at template-render time.
  desktopDownloadUrl: str(
    'DESKTOP_DOWNLOAD_URL',
    'https://github.com/KisaesDevLab/Vibe-Connect/releases/latest',
  ),

  // Where the tlsAcme service writes issued certs. Inside the container the
  // app mounts the same host directory that nginx read-only-mounts, so a
  // file write here is picked up by nginx's inotify loop.
  tlsOutputDir: str('TLS_OUTPUT_DIR', './tls'),
  // ACME directory URLs. Defaults to the public LE endpoints; overridable so
  // tests can point at Pebble and on-prem deployments can target a private ACME.
  acmeDirectoryStaging: str(
    'ACME_DIRECTORY_STAGING',
    'https://acme-staging-v02.api.letsencrypt.org/directory',
  ),
  acmeDirectoryProduction: str(
    'ACME_DIRECTORY_PRODUCTION',
    'https://acme-v02.api.letsencrypt.org/directory',
  ),
};

if (env.isProd && !env.sessionSecret) {
  throw new Error('SESSION_SECRET is required in production');
}

if (env.isProd && !env.clamdHost && !env.allowUnscannedUploads) {
  // Silent fail-open is the worst of both worlds: operators assume AV is on
  // because the appliance boots cleanly. Refuse to start so the misconfig is
  // visible on day zero. The ALLOW_UNSCANNED_UPLOADS opt-out is for isolated
  // networks where the operator has made a conscious risk decision.
  throw new Error(
    'CLAMD_HOST must be set in production, or set ALLOW_UNSCANNED_UPLOADS=1 to acknowledge shipping without AV scanning.',
  );
}

if (env.attachmentDriver === 's3' && env.s3Endpoint && !env.s3AllowPrivateEndpoint) {
  // Reject literal RFC1918 / loopback / link-local IPv4 in S3_ENDPOINT to
  // catch misconfigurations that would make the appliance speak to an
  // internal service (including cloud metadata endpoints). Hostnames are
  // allowed because self-hosted MinIO legitimately uses docker-network
  // names like `minio`; operators can also set S3_ALLOW_PRIVATE_ENDPOINT=1
  // if they genuinely need to point at a literal private IP.
  try {
    const u = new URL(env.s3Endpoint);
    const host = u.hostname;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) {
      // v4[1..4] are the four octets; map to numbers directly rather than
      // relying on a tuple cast over the full match array. Any NaN here
      // means the regex matched a non-numeric capture, which can't happen
      // with \d{1,3}, but we gate on isNaN anyway.
      const a = Number(v4[1]);
      const b = Number(v4[2]);
      const isPrivate =
        !Number.isNaN(a) &&
        !Number.isNaN(b) &&
        (a === 127 ||
          a === 0 ||
          a === 10 ||
          (a === 169 && b === 254) ||
          (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 168));
      if (isPrivate) {
        throw new Error(
          `S3_ENDPOINT points at a private IPv4 literal (${host}). Either use a hostname (e.g. "minio") or set S3_ALLOW_PRIVATE_ENDPOINT=1 to acknowledge the SSRF risk surface.`,
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('S3_ENDPOINT points at')) throw err;
    throw new Error(`S3_ENDPOINT is not a valid URL: ${env.s3Endpoint}`);
  }
}

if (env.backupRequired && env.backupHeartbeatToken.length < 32) {
  // Without a long, opaque token any HTTP caller can clear the staleness
  // gate by POSTing to /admin/backup-heartbeat. The check is a 32-char
  // floor rather than a strict format because operators may want to
  // generate it via `openssl rand -hex 32` (64 hex chars), via a UUID
  // generator (36 chars), or via a passphrase-style mnemonic — only
  // entropy matters.
  throw new Error(
    'BACKUP_REQUIRED=true demands BACKUP_HEARTBEAT_TOKEN of at least 32 characters. Generate with: openssl rand -hex 32',
  );
}

if (env.isProd && process.env.SESSION_SECURE === undefined) {
  // SESSION_SECURE controls the `Secure` cookie flag. Leaving it implicit
  // means a production deploy with NODE_ENV accidentally set to something
  // other than "production" in an upstream container flips the flag off,
  // shipping session cookies over cleartext HTTP. Force the operator to
  // state their intent so the value can never be "whatever the default
  // happens to compute."
  throw new Error(
    'SESSION_SECURE must be set explicitly in production (expected "true"; set to "false" only if a TLS-terminating proxy fronts the app and cookies must traverse an internal HTTP hop).',
  );
}
