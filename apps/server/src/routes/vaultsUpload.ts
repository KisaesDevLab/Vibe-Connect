// Phase 26 — tus protocol tail for staff vault uploads.
//
// HEAD / PATCH / DELETE on `/clients/:id/vault/uploads/:uploadId`. Creation
// (POST .../uploads) lives in routes/vaults.ts so the staff-membership
// check stays adjacent to the rest of the staff endpoints.
//
// PATCH binds to the creator session (vault_uploads_in_progress.created_by_user_id)
// — a different user's session cookie can't resume someone else's upload.
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireVaultEnabled } from '../middleware/vaultEnabled.js';
import { tusDelete, tusHead, tusPatch } from '../services/tusServer.js';

export const vaultsUploadRouter = Router();

vaultsUploadRouter.use(requireAuth, requireVaultEnabled);

vaultsUploadRouter.head(
  '/clients/:id/vault/uploads/:uploadId',
  asyncHandler(async (req, res) => {
    await tusHead(req, res, req.params.uploadId!);
  }),
);

vaultsUploadRouter.patch(
  '/clients/:id/vault/uploads/:uploadId',
  asyncHandler(async (req, res) => {
    const userId = req.session.userId!;
    await tusPatch(
      req,
      res,
      req.params.uploadId!,
      { userId, externalIdentityId: null },
      {
        actorUserId: userId,
        actorExternalIdentityId: null,
      },
    );
  }),
);

vaultsUploadRouter.delete(
  '/clients/:id/vault/uploads/:uploadId',
  asyncHandler(async (req, res) => {
    await tusDelete(req, res, req.params.uploadId!, {
      userId: req.session.userId!,
      externalIdentityId: null,
    });
  }),
);
