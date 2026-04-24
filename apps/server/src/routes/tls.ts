// Admin-facing TLS / ACME endpoints. Mounted as a child router under
// /admin via adminRouter.use('/', tlsRouter) in routes/admin.ts.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import { logger } from '../logger.js';
import { auditRepo } from '../repositories/audit.js';
import {
  getStatus,
  isOrderInFlight,
  renewIfExpiring,
  revokeAndWipe,
  runAcmeOrder,
} from '../services/tlsAcme.js';

export const tlsRouter = Router();

// 5/hr per admin session. ACME has strict per-account + per-domain rate
// limits and a compromised admin cookie shouldn't be able to burn them.
const tlsWriteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
  keyGenerator: (req) => req.session.userId ?? req.ip ?? 'anon',
});

tlsRouter.get(
  '/tls/status',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const status = await getStatus();
    res.json(status);
  }),
);

tlsRouter.post(
  '/tls/request',
  requireAdmin,
  tlsWriteLimiter,
  asyncHandler(async (req, res) => {
    if (isOrderInFlight()) {
      res.status(409).json({ error: 'order_in_flight' });
      return;
    }
    // Kick off async — the handler returns immediately so the UI can poll
    // /admin/tls/status. Errors are captured into firm_settings.tls_last_error
    // by the service itself; we just log the completion.
    const actorUserId = req.session.userId ?? null;
    void runAcmeOrder({ actorUserId }).catch((err: unknown) => {
      logger.error('tls.request_background_failed', {
        msg: err instanceof Error ? err.message : String(err),
      });
    });
    res.status(202).json({ ok: true, accepted: true });
  }),
);

tlsRouter.post(
  '/tls/renew',
  requireAdmin,
  tlsWriteLimiter,
  asyncHandler(async (req, res) => {
    if (isOrderInFlight()) {
      res.status(409).json({ error: 'order_in_flight' });
      return;
    }
    const actorUserId = req.session.userId ?? null;
    void renewIfExpiring({ actorUserId, force: true }).catch((err: unknown) => {
      logger.error('tls.renew_background_failed', {
        msg: err instanceof Error ? err.message : String(err),
      });
    });
    res.status(202).json({ ok: true, accepted: true });
  }),
);

tlsRouter.delete(
  '/tls/config',
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (isOrderInFlight()) {
      res.status(409).json({ error: 'order_in_flight' });
      return;
    }
    await revokeAndWipe(req.session.userId ?? null);
    await auditRepo.write({
      actorUserId: req.session.userId ?? undefined,
      action: 'admin.tls_cleared',
      targetType: 'firm_settings',
    });
    res.json({ ok: true });
  }),
);
