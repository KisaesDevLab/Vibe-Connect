import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import ConnectPgSimple from 'connect-pg-simple';
import { env } from './env.js';
import { logger } from './logger.js';
import { adminRouter, clientsRouter, firmRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { conversationsRouter } from './routes/conversations.js';
import { firstBootRouter } from './routes/firstBoot.js';
import { oidcRouter } from './routes/oidc.js';
import { groupsRouter } from './routes/groups.js';
import { notificationsRouter } from './routes/notifications.js';
import { portalRouter } from './routes/portal.js';
import { portalConversationsRouter } from './routes/portalConversations.js';
import { portalUploadRouter } from './routes/portalUpload.js';
import { emailBridgeRouter } from './routes/emailBridge.js';
import { smsBridgeRouter } from './routes/smsBridge.js';
import { serveAvatarFromDisk, usersRouter } from './routes/users.js';
import { requestLog } from './middleware/requestLog.js';
import { reqContext } from './middleware/reqContext.js';
import { getHttp01KeyAuthorization } from './services/tlsAcme.js';

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', 1);

  // ACME HTTP-01 challenge responder. Registered before EVERY middleware —
  // including requestLog, helmet, session, and global rate-limiting — so LE
  // validation probes from the internet hit nothing but this handler. The
  // in-memory token map is populated by services/tlsAcme during an active
  // order; unknown tokens fall through to a plain 404. Never audit-logged:
  // LE hammers this endpoint during challenge setup and a log row per token
  // would just be noise.
  app.get('/.well-known/acme-challenge/:token', (req, res) => {
    const token = req.params.token ?? '';
    // ACME HTTP-01 tokens are 43-char base64url per RFC 8555. Cap well above
    // that so a 1 MB garbage string can't be dispatched into the in-memory
    // token map lookup — both to save cycles and to keep log lines short.
    if (token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    const keyAuth = getHttp01KeyAuthorization(token);
    if (!keyAuth) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    res.status(200).type('text/plain').send(keyAuth);
  });

  // Request ID must come first so downstream middleware and handlers can log with it.
  app.use(requestLog);
  app.use(reqContext);

  app.use(
    helmet({
      contentSecurityPolicy: false, // SPA sets its own CSP at nginx layer
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Appliance CORS. On-prem installs are accessed by the LAN host's IP, a
  // local DNS name, a LAN-signed cert CN, a reverse-proxy hostname — we can't
  // enumerate them at build time. Reflect the request origin; actual write
  // protection comes from the same-site session cookie (SameSite=lax) and
  // requireAuth middleware on every privileged route, not from CORS.
  app.use(
    cors({
      origin: (origin, cb) => cb(null, origin ?? true),
      credentials: true,
    }),
  );

  // Capture the raw request bytes BEFORE JSON/urlencoded parsing mutates them.
  // Webhook signature schemes (TextLink HMAC on the raw body, Twilio's param
  // signature) need the byte-exact payload the provider signed — JSON.stringify
  // of a parsed object is NOT byte-equivalent (whitespace, key order, Unicode
  // escapes can diverge). We stash on `req.rawBody` and let webhook handlers
  // read it for verification. Only set for bridge paths to keep memory bounded.
  const captureRawBody = (
    req: Request,
    _res: Response,
    buf: Buffer,
    _encoding: string,
  ): void => {
    if (buf && buf.length && req.path.startsWith('/bridges/')) {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    }
  };
  // Per-route body size caps.
  //
  // Default 1 MB covers nearly every request the app makes (auth, portal
  // verify, conversations API, admin panel writes). Small cap tightens the
  // DoS surface — a 10 MB JSON body on /auth/login buys an attacker nothing
  // but CPU cost on the server.
  //
  // Message payloads carry base64-encoded ciphertext up to ~20 MB per the
  // messageCreateSchema (routes/conversations.ts), so /conversations needs
  // a larger cap. Inbound email webhooks deliver whole MIME messages with
  // attachments and legitimately exceed 20 MB for multi-file forwards.
  //
  // Multer-handled multipart routes (attachment uploads, avatar uploads)
  // set their own limits and aren't affected by this middleware.
  const DEFAULT_BODY = '1mb';
  const MESSAGE_BODY = '25mb';
  const EMAIL_INBOUND_BODY = '50mb';
  app.use('/bridges/email-inbound', express.json({ limit: EMAIL_INBOUND_BODY, verify: captureRawBody }));
  app.use(
    '/bridges/email-inbound-raw',
    express.json({ limit: EMAIL_INBOUND_BODY, verify: captureRawBody }),
  );
  app.use('/conversations', express.json({ limit: MESSAGE_BODY, verify: captureRawBody }));
  app.use('/portal/conversations', express.json({ limit: MESSAGE_BODY, verify: captureRawBody }));
  app.use(express.json({ limit: DEFAULT_BODY, verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, limit: DEFAULT_BODY, verify: captureRawBody }));
  app.use(cookieParser());

  // Session must come BEFORE the global rate limit so the limiter can key on
  // `req.session.userId` for authenticated callers. Without this, a 50-person
  // firm sharing one NAT'd public IP collectively shares the 600/min cap and
  // trips 429s under normal traffic.
  const PgStore = ConnectPgSimple(session);
  app.use(
    session({
      name: env.sessionCookieName,
      secret: env.sessionSecret,
      store: new PgStore({
        conString: env.nodeEnv === 'test' ? env.testDatabaseUrl : env.databaseUrl,
        tableName: 'session',
        createTableIfMissing: false,
        pruneSessionInterval: 60,
      }),
      cookie: {
        httpOnly: true,
        secure: env.sessionSecure,
        sameSite: env.sessionSameSite,
        maxAge: 1000 * 60 * 60 * 12, // 12h
      },
      saveUninitialized: false,
      resave: false,
      rolling: true,
    }),
  );

  // Collapse an IPv6 address to its /64 prefix so a single caller can't
  // trivially cycle through 2**64 sub-addresses to bypass rate limits.
  // IPv4 passes through unchanged. express-rate-limit 7.x doesn't export a
  // helper for this in our pinned version, so the collapse lives here.
  const ipBucket = (rawIp: string | undefined): string => {
    if (!rawIp) return 'anon';
    // IPv4-mapped IPv6 like "::ffff:1.2.3.4" — strip the prefix.
    const stripped = rawIp.replace(/^::ffff:/i, '');
    if (stripped.includes(':')) {
      // IPv6: take first 4 groups (the /64 routing prefix). Expand "::" to
      // zeros so "2001:db8::1" becomes "2001:db8:0:0".
      const groups = stripped.split(':');
      // "::" introduces empty strings; pad to 8 groups.
      const expanded: string[] = [];
      let filled = false;
      for (const g of groups) {
        if (g === '' && !filled) {
          const zeros = 8 - (groups.length - 1);
          for (let i = 0; i < zeros; i++) expanded.push('0');
          filled = true;
        } else if (g !== '') {
          expanded.push(g);
        }
      }
      while (expanded.length < 8) expanded.push('0');
      return `v6:${expanded.slice(0, 4).join(':')}`;
    }
    return `v4:${stripped}`;
  };
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: env.rateLimitGlobalPerMin,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path === '/health',
      // Key authenticated users by session userId so the office NAT doesn't
      // cluster every staff member into one rate bucket. Anonymous requests
      // and portal clients (no `userId` in the staff session) fall back to IP
      // collapsed to /64 for IPv6 (see ipBucket).
      keyGenerator: (req) => {
        const uid = req.session?.userId;
        if (uid) return `u:${uid}`;
        return ipBucket(req.ip);
      },
    }),
  );

  app.get('/health', (_req, res) => {
    // Keep the response minimal — this endpoint is publicly reachable (no
    // auth, skipped from the global rate-limit) and anything we return here
    // is fingerprintable by attackers scanning for known-version exploits.
    // Node version used to be in the payload; it's now moved to the logs
    // where only an admin with host access can read it.
    res.json({ ok: true, service: 'vibe-connect-server' });
  });

  app.use('/auth', authRouter);
  app.use('/auth/oidc', oidcRouter);
  app.use('/users', usersRouter);
  app.use('/groups', groupsRouter);
  app.use('/conversations', conversationsRouter);
  app.use('/admin', adminRouter);
  app.use('/clients', clientsRouter);
  app.use('/firm', firmRouter);
  app.use('/notifications', notificationsRouter);
  app.use('/install', firstBootRouter);
  app.use('/portal', portalRouter);
  app.use('/portal/conversations', portalConversationsRouter);
  app.use('/portal/conversations', portalUploadRouter);
  app.use('/bridges', emailBridgeRouter);
  app.use('/bridges', smsBridgeRouter);

  // Avatar file serving — requires auth for staff app.
  app.get('/attachments/avatars/:name', async (req, res) => {
    if (!req.session.userId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const name = path.basename(req.params.name!);
    // Only libsodium-wrapped .enc avatars are served; see usersRouter POST /me/avatar.
    if (!/^[0-9a-fA-F-]{36}\.(png|jpg|jpeg|webp|gif)\.enc$/.test(name)) {
      res.status(400).json({ error: 'bad_name' });
      return;
    }
    const buf = await serveAvatarFromDisk(name);
    if (!buf) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const ext = name.match(/\.(png|jpe?g|webp|gif)\.enc$/)?.[1]?.toLowerCase() ?? 'jpeg';
    const mime =
      ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : 'image/jpeg';
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: unknown }).status;
    const code = (err as { code?: unknown }).code;
    const reqId = req.reqId;
    if (typeof status === 'number' && status >= 400 && status < 600) {
      logger.warn('request_client_error', { reqId, status, code, msg: err.message });
      res
        .status(status)
        .json({ error: typeof code === 'string' ? code : 'error', reqId });
      return;
    }
    logger.error('request_error', { reqId, msg: err.message, stack: err.stack });
    res.status(500).json({ error: 'internal_error', reqId });
  });

  return app;
}
