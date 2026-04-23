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

const isProd = process.env.NODE_ENV === 'production';

export const env = {
  nodeEnv: (process.env.NODE_ENV ?? 'development') as 'development' | 'test' | 'production',
  isProd,
  port: num('PORT', 4000),
  siteUrl: str('SITE_URL', 'http://localhost:5173'),
  portalUrl: str('PORTAL_URL', 'http://localhost:5174'),
  apiUrl: str('API_URL', 'http://localhost:4000'),

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

  emailProvider: str('EMAIL_PROVIDER', 'mock') as 'mock' | 'postmark' | 'postfix',
  emailFrom: str('EMAIL_FROM', 'Vibe Connect <noreply@vibeconnect.local>'),
  emailInboundDomain: str('EMAIL_INBOUND_DOMAIN', 'connect.vibeconnect.local'),
  postmarkServerToken: str('POSTMARK_SERVER_TOKEN', ''),
  postmarkInboundWebhookSecret: str('POSTMARK_INBOUND_WEBHOOK_SECRET', ''),

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

  stepupDefaultTimeoutHours: num('STEPUP_DEFAULT_TIMEOUT_HOURS', 24),

  outboxDir: str('OUTBOX_DIR', './.outbox'),
};

if (env.isProd && !env.sessionSecret) {
  throw new Error('SESSION_SECRET is required in production');
}
