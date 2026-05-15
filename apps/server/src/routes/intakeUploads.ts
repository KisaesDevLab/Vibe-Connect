// Phase 28.5 — tus protocol mount for the anonymous intake upload pipeline.
//
// Mounted at `/api/public/intake/uploads` by app.ts. Kept as a sibling
// of intakePublicRouter (rather than nested under it) so the tus PATCH
// body — which uses `application/offset+octet-stream` and streams
// directly to disk — never sees express.json's body-parser pipeline.
//
// CORS is permissive here because anonymous walk-up clients hit this from
// the same origin as the SPA bundle (the intake landing). No credentials
// ride along — auth is the upload-token JWT in the Authorization header,
// not a cookie.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  intakeTusCreate,
  intakeTusDelete,
  intakeTusHead,
  intakeTusOptions,
  intakeTusPatch,
} from '../services/intakeTusServer.js';
import { db } from '../db/knex.js';

export const intakeUploadsRouter = Router();

/**
 * Phase 28.16 — gate writes (POST/PATCH/DELETE) on
 * `firm_settings.intake_maintenance_mode`. Reads (OPTIONS/HEAD) stay live
 * so the SPA can probe Tus-Max-Size and an interrupted client can ask
 * "where did I leave off?" without uploading bytes.
 */
async function requireUploadsEnabled(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const row = await db('firm_settings')
    .where({ id: 1 })
    .first<{ intake_maintenance_mode: boolean }>('intake_maintenance_mode');
  if (row?.intake_maintenance_mode) {
    res.status(503).json({ error: 'maintenance' });
    return;
  }
  next();
}

// OPTIONS exposes Tus-Version / Tus-Extension / Tus-Max-Size — the SPA's
// tus-js-client discovers capabilities on first use. The max here is the
// per-file cap from firm_settings, not the session aggregate.
intakeUploadsRouter.options(
  '/',
  asyncHandler(async (req, res) => {
    const settings = await db('firm_settings').where({ id: 1 }).first('intake_max_file_bytes');
    const maxFile = Number(settings?.intake_max_file_bytes ?? 50 * 1024 * 1024);
    intakeTusOptions(req, res, maxFile);
  }),
);

intakeUploadsRouter.post('/', asyncHandler(requireUploadsEnabled), asyncHandler(intakeTusCreate));
intakeUploadsRouter.head('/:id', asyncHandler(intakeTusHead));
intakeUploadsRouter.patch(
  '/:id',
  asyncHandler(requireUploadsEnabled),
  asyncHandler(intakeTusPatch),
);
intakeUploadsRouter.delete(
  '/:id',
  asyncHandler(requireUploadsEnabled),
  asyncHandler(intakeTusDelete),
);
