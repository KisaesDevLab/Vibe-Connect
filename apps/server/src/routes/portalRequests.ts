// Phase 24.2 — Portal-facing routes for request lists.
//
// Read-only from the portal's perspective: the client GETs lists + items for
// any conversation they're a member of, then submits responses by POSTing
// messages on the existing /portal/conversations/:id/messages endpoint with
// `ciphertextMeta.requestItemId` set. The server-side post-insert hook in
// portalConversations.ts then auto-flips the item status.
//
// This module deliberately does NOT expose any write endpoints — clients
// can't create lists, edit items, or mark anything done. The implicit
// authorization model is "you can read what you can be a member of, you
// can write only via messages".
import { Router, type Request as ExpressRequest } from 'express';
import { db } from '../db/knex.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { presentItem, presentList, RequestsServiceError } from '../services/requestsService.js';
import {
  requestItemsRepo,
  requestListsRepo,
  type RequestListRow,
} from '../repositories/requests.js';
import { loadSessionFromCookie } from './portal.js';

export const portalRequestsRouter = Router();

interface PortalSessionShim {
  external_identity_id: string;
  verified_until: string | null;
}

portalRequestsRouter.use(
  asyncHandler(async (req, res, next) => {
    const session = await loadSessionFromCookie(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    (req as unknown as { clientSession: PortalSessionShim }).clientSession = session;
    next();
  }),
);

/**
 * Phase 24 follow-up: kill-switch shim for the portal-side panel. When the
 * firm has disabled requests, return an empty list with `requestsDisabled:
 * true` instead of 403 so a portal session that has the panel open silently
 * loses content rather than crashing. The detail endpoint 403s though —
 * direct deep-links shouldn't render stale data.
 */
async function isRequestsDisabled(): Promise<boolean> {
  const settings = await db('firm_settings').where({ id: 1 }).first('requests_enabled');
  return settings ? settings.requests_enabled === false : false;
}

function getSession(req: ExpressRequest): PortalSessionShim {
  return (req as unknown as { clientSession: PortalSessionShim }).clientSession;
}

/**
 * STEPUP: matches the gate the conversation routes enforce
 * (portalConversations.ts). When the firm requires SSN/EIN verification and
 * the session hasn't satisfied it, refuse to ship list metadata or item
 * ciphertext. List titles often encode engagement names ("Smith Family
 * 1040") that are exactly what step-up verification is meant to gate.
 */
async function isStepupNeeded(
  externalIdentityId: string,
  verifiedUntil: string | null,
): Promise<boolean> {
  const identity = await db('external_identities')
    .where({ id: externalIdentityId })
    .first('verification_required', 'verification_last4_hash');
  if (!identity) return false;
  return (
    Boolean(identity.verification_required) &&
    Boolean(identity.verification_last4_hash) &&
    (!verifiedUntil || new Date(verifiedUntil) < new Date())
  );
}

/**
 * Returns true when this external identity is a current member of the given
 * conversation. Mirrors the portalConversations.ts membership check pattern
 * — kept local because the staff-side conversationMembersRepo.isMember
 * helper is keyed by user_id, not external_identity_id.
 */
async function isExternalMember(
  conversationId: string,
  externalIdentityId: string,
): Promise<boolean> {
  const row = await db('conversation_members')
    .where({
      conversation_id: conversationId,
      external_identity_id: externalIdentityId,
    })
    .whereNull('removed_at')
    .first();
  return Boolean(row);
}

/**
 * GET /portal/request-lists
 * Active lists across every conversation the client is a member of. Used by
 * the portal home banner ("you have N items pending") and the in-conversation
 * Requests pill.
 */
portalRequestsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const session = getSession(req);
    if (await isRequestsDisabled()) {
      res.json({ requestsDisabled: true, lists: [] });
      return;
    }
    if (await isStepupNeeded(session.external_identity_id, session.verified_until)) {
      res.json({ stepupRequired: true, lists: [] });
      return;
    }
    // Pull every conversation the client is currently in, then fan out to
    // request_lists. Single round trip via a join keeps the query honest as
    // the client's roster grows past a handful of engagements.
    const rows = (await db('request_lists as rl')
      .innerJoin('conversation_members as cm', 'cm.conversation_id', 'rl.conversation_id')
      .where({
        'cm.external_identity_id': session.external_identity_id,
        'rl.status': 'active',
      })
      .whereNull('cm.removed_at')
      .select('rl.*')) as RequestListRow[];
    res.json({ lists: rows.map(presentList) });
  }),
);

/**
 * GET /portal/request-lists/:id
 * Single list with all items. Refuses if the caller isn't a current member
 * of the list's conversation.
 */
portalRequestsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const session = getSession(req);
    if (await isRequestsDisabled()) {
      res.status(403).json({ error: 'requests_disabled' });
      return;
    }
    if (await isStepupNeeded(session.external_identity_id, session.verified_until)) {
      res.status(403).json({ error: 'stepup_required' });
      return;
    }
    const list = await requestListsRepo.byId(req.params.id!);
    if (!list) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const ok = await isExternalMember(list.conversation_id, session.external_identity_id);
    if (!ok) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const items = await requestItemsRepo.listByListId(list.id);
    res.json({ list: { ...presentList(list), items: items.map(presentItem) } });
  }),
);

// Re-export so app.ts can mount it without re-importing every symbol.
export { RequestsServiceError };
