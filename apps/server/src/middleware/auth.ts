import type { NextFunction, Request, Response } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!req.session.isAdmin) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}
