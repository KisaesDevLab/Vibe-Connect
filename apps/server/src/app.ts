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
import { adminRouter, firmRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { conversationsRouter } from './routes/conversations.js';
import { firstBootRouter } from './routes/firstBoot.js';
import { groupsRouter } from './routes/groups.js';
import { notificationsRouter } from './routes/notifications.js';
import { portalRouter } from './routes/portal.js';
import { portalConversationsRouter } from './routes/portalConversations.js';
import { portalUploadRouter } from './routes/portalUpload.js';
import { emailBridgeRouter } from './routes/emailBridge.js';
import { smsBridgeRouter } from './routes/smsBridge.js';
import { serveAvatarFromDisk, usersRouter } from './routes/users.js';

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: false, // SPA sets its own CSP at nginx layer
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    cors({
      origin: [env.siteUrl, env.portalUrl],
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: env.rateLimitGlobalPerMin,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path === '/health',
    }),
  );

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

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'vibe-connect-server', node: process.version });
  });

  app.use('/auth', authRouter);
  app.use('/users', usersRouter);
  app.use('/groups', groupsRouter);
  app.use('/conversations', conversationsRouter);
  app.use('/admin', adminRouter);
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
    // Only .enc-wrapped avatars are served; the xorWrap key is the server's session secret.
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
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: unknown }).status;
    const code = (err as { code?: unknown }).code;
    if (typeof status === 'number' && status >= 400 && status < 600) {
      logger.warn('request_client_error', { status, code, msg: err.message });
      res.status(status).json({ error: typeof code === 'string' ? code : 'error' });
      return;
    }
    logger.error('request_error', { msg: err.message, stack: err.stack });
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
