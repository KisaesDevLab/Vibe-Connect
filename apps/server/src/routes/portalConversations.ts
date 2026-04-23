// Portal-side conversation + message routes. Gated on client session + (optionally) step-up.
// CRYPTO(STEPUP): wrapped conversation keys are only emitted when verified_until is valid.
import { Router } from 'express';
import { db } from '../db/knex.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { auditRepo } from '../repositories/audit.js';
import { loadSessionFromCookie } from './portal.js';

export const portalConversationsRouter = Router();

portalConversationsRouter.use(
  asyncHandler(async (req, res, next) => {
    const session = await loadSessionFromCookie(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    (req as unknown as { clientSession: typeof session }).clientSession = session;
    next();
  }),
);

portalConversationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const session = (req as unknown as { clientSession: { external_identity_id: string } })
      .clientSession;
    const rows = await db('conversations as c')
      .innerJoin('conversation_members as cm', 'cm.conversation_id', 'c.id')
      .where({ 'cm.external_identity_id': session.external_identity_id })
      .whereNull('cm.removed_at')
      .select('c.id', 'c.display_name as displayName', 'c.updated_at as updatedAt')
      .orderBy('c.updated_at', 'desc');
    res.json({ conversations: rows });
  }),
);

portalConversationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const session = (
      req as unknown as {
        clientSession: { id: string; external_identity_id: string; verified_until: string | null };
      }
    ).clientSession;

    // Membership check.
    const isMember = await db('conversation_members')
      .where({
        conversation_id: req.params.id!,
        external_identity_id: session.external_identity_id,
      })
      .whereNull('removed_at')
      .first();
    if (!isMember) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // Phase 24: clients MUST NEVER see an internal_thread — belt-and-suspenders on top of
    // the membership check. If the conversation type is 'internal_thread' we refuse.
    const conv0 = await db('conversations').where({ id: req.params.id! }).first();
    if (!conv0 || conv0.type === 'internal_thread' || conv0.type === 'internal') {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const identity = await db('external_identities')
      .where({ id: session.external_identity_id })
      .first();
    // STEPUP: if the firm requires step-up verification and the session hasn't satisfied it,
    // refuse to hand over the wrapped keys. The client must complete /portal/stepup first.
    const stepupNeeded =
      Boolean(identity?.verification_required) &&
      Boolean(identity?.verification_last4_hash) &&
      (!session.verified_until || new Date(session.verified_until) < new Date());

    const conv = await db('conversations').where({ id: req.params.id! }).first();
    if (!conv) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const keys = stepupNeeded
      ? null
      : await db('conversation_keys')
          .where({ conversation_id: conv.id })
          .orderBy('rotation_version', 'desc')
          .first();

    await auditRepo.write({
      actorExternalIdentityId: session.external_identity_id,
      action: stepupNeeded ? 'portal.convkey_withheld_stepup' : 'portal.conversation_viewed',
      targetType: 'conversation',
      targetId: conv.id,
    });

    res.json({
      id: conv.id,
      displayName: conv.display_name,
      stepupRequired: stepupNeeded,
      rotationVersion: keys?.rotation_version ?? null,
      wrappedKeys: keys?.wrapped_keys ?? null,
    });
  }),
);

portalConversationsRouter.get(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const session = (
      req as unknown as {
        clientSession: { external_identity_id: string; verified_until: string | null };
      }
    ).clientSession;
    const member = await db('conversation_members')
      .where({
        conversation_id: req.params.id!,
        external_identity_id: session.external_identity_id,
      })
      .whereNull('removed_at')
      .first();
    if (!member) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Messages are ciphertext; returning them without the key is harmless, but we still
    // enforce the gate on the key endpoint above.
    const rows = await db('messages')
      .where({ conversation_id: req.params.id! })
      .whereNull('deleted_at')
      .where((b) => b.whereNull('scheduled_for').orWhere('scheduled_for', '<=', db.fn.now()))
      .orderBy('created_at', 'desc')
      .limit(100);
    res.json({
      messages: rows.reverse().map((m) => ({
        id: m.id,
        senderId: m.sender_id,
        senderExternalIdentityId: m.sender_external_identity_id,
        ciphertext: (m.ciphertext as Buffer).toString('base64'),
        contentKeyVersion: m.content_key_version,
        urgent: m.urgent,
        source: m.source,
        createdAt: m.created_at,
        editedAt: m.edited_at,
      })),
    });
  }),
);
