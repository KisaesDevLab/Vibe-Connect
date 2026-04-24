// Request-scoped context carried across async boundaries, used by auditRepo to
// automatically tag every audit row with the request ID that triggered it.
// Without this, threading reqId through ~30 call sites would be noise; with it,
// any code reachable from within an Express handler can call `currentReqId()`.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

interface ReqContext {
  reqId: string;
}

const storage = new AsyncLocalStorage<ReqContext>();

export function reqContext(req: Request, _res: Response, next: NextFunction): void {
  storage.run({ reqId: req.reqId }, () => next());
}

export function currentReqId(): string | null {
  return storage.getStore()?.reqId ?? null;
}
