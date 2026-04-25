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
    throw new Error(
      `Invalid ${key}=${v}; expected one of ${allowed.join(', ')}`,
    );
  }
  return v as T;
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

  emailProvider: str('EMAIL_PROVIDER', 'mock') as 'mock' | 'postmark' | 'postfix',
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
  // Bridge-inbound limiters. Shared-secret webhook auth already keeps random
  // callers out, but a misconfigured provider or leaked secret could flood
  // the appliance. These cap the surge per source IP.
  rateLimitEmailInboundPerMin: num('RATE_LIMIT_EMAIL_INBOUND_PER_MIN', 200),
  rateLimitSmsInboundPerMin: num('RATE_LIMIT_SMS_INBOUND_PER_MIN', 500),

  stepupDefaultTimeoutHours: num('STEPUP_DEFAULT_TIMEOUT_HOURS', 24),

  outboxDir: str('OUTBOX_DIR', './.outbox'),

  clamdHost: str('CLAMD_HOST', ''),
  clamdPort: num('CLAMD_PORT', 3310),
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
