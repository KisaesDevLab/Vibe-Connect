// Per-request ID generation, response-header echo, and structured access log.
// Every log line emitted by a route's handler can correlate with a single
// `reqId` in the access log — crucial for debugging on a firm-local appliance
// where there's no distributed tracing.
import type { NextFunction, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { logger } from '../logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    reqId: string;
  }
}

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  // Client-supplied X-Request-Ids are echoed back for trace stitching (nginx,
  // Tauri client, load balancer upstream), but we prefix them with `ext:` so
  // a reader of the access log / audit stream can always distinguish a
  // caller-chosen value from a server-minted one. Otherwise an attacker could
  // set X-Request-Id to "admin-override-12345" and later muddy incident
  // review by blending their requests into a search filter the operator runs
  // against server-minted IDs.
  //
  // Guard against a caller echoing back an already-tagged value: if they send
  // `ext:abc` we don't want to end up with `ext:ext:abc` (and a 4-byte
  // truncation would cut the meaningful tail). Strip the prefix first so the
  // final ID is always exactly one `ext:`.
  const rawIncoming = req.header('x-request-id');
  const incoming = rawIncoming?.replace(/^ext:/, '');
  const reqId =
    incoming && /^[A-Za-z0-9._-]{1,64}$/.test(incoming)
      ? `ext:${incoming}`
      : randomBytes(4).toString('hex');
  req.reqId = reqId;
  res.setHeader('X-Request-Id', reqId);

  // Capture the full URL now — Express mutates `req.path` / `req.url` as it
  // descends into mounted routers, so by the time `res.on('finish')` fires the
  // value is the path relative to the deepest handler (e.g. `/status` for a
  // request to `/install/status`). `req.originalUrl` is immune to this.
  const fullUrl = req.originalUrl;
  const pathOnly = fullUrl.split('?')[0] ?? fullUrl;
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const dur = Number(process.hrtime.bigint() - start) / 1_000_000;
    // Skip health-check spam; everything else gets a single line.
    if (pathOnly === '/health') return;
    logger.info('request', {
      reqId,
      method: req.method,
      path: pathOnly,
      status: res.statusCode,
      ms: Math.round(dur),
      userId: req.session?.userId ?? null,
      ip: req.ip,
    });
  });
  next();
}
