import type { NextFunction, Request, RequestHandler, Response } from 'express';

export function asyncHandler<Req extends Request = Request, Res extends Response = Response>(
  fn: (req: Req, res: Res, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req as Req, res as Res, next).catch(next);
  };
}
