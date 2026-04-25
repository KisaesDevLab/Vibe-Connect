// Phase 26 — tus protocol tail for portal vault uploads.
//
// HEAD / PATCH / DELETE on `/portal/vault/uploads/:uploadId`. The upload row
// is bound at creation to `created_by_external_identity_id`, so a different
// session's cookie can't resume an upload — the tus auth check rejects with
// 403. Step-up isn't re-checked on PATCH/DELETE: the gate is enforced at
// upload-creation time (POST .../uploads) and on file download. PATCH on
// an already-created upload is the encrypted ciphertext flowing in.
import { Router, type Request } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { checkVaultEnabledSoft } from '../middleware/vaultEnabled.js';
import { tusDelete, tusHead, tusPatch } from '../services/tusServer.js';
import { loadSessionFromCookie } from './portal.js';

export const portalVaultUploadRouter = Router();

interface PortalSessionAttached {
  clientSession: { id: string; external_identity_id: string };
  vaultDisabled?: boolean;
}

portalVaultUploadRouter.use(
  asyncHandler(async (req, res, next) => {
    const session = await loadSessionFromCookie(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    (req as Request & PortalSessionAttached).clientSession = session;
    next();
  }),
  checkVaultEnabledSoft,
);

function getSession(req: Request): PortalSessionAttached['clientSession'] {
  return (req as Request & PortalSessionAttached).clientSession;
}
function isVaultDisabled(req: Request): boolean {
  return Boolean((req as Request & PortalSessionAttached).vaultDisabled);
}

portalVaultUploadRouter.head(
  '/portal/vault/uploads/:uploadId',
  asyncHandler(async (req, res) => {
    if (isVaultDisabled(req)) {
      res.status(403).json({ error: 'vault_disabled' });
      return;
    }
    await tusHead(req, res, req.params.uploadId!);
  }),
);

portalVaultUploadRouter.patch(
  '/portal/vault/uploads/:uploadId',
  asyncHandler(async (req, res) => {
    if (isVaultDisabled(req)) {
      res.status(403).json({ error: 'vault_disabled' });
      return;
    }
    const session = getSession(req);
    await tusPatch(
      req,
      res,
      req.params.uploadId!,
      { userId: null, externalIdentityId: session.external_identity_id },
      {
        actorUserId: null,
        actorExternalIdentityId: session.external_identity_id,
      },
    );
  }),
);

portalVaultUploadRouter.delete(
  '/portal/vault/uploads/:uploadId',
  asyncHandler(async (req, res) => {
    if (isVaultDisabled(req)) {
      res.status(403).json({ error: 'vault_disabled' });
      return;
    }
    const session = getSession(req);
    await tusDelete(req, res, req.params.uploadId!, {
      userId: null,
      externalIdentityId: session.external_identity_id,
    });
  }),
);
