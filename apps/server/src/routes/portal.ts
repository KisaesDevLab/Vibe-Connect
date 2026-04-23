// Client portal routes: identify, verify code, step-up, session helpers.
// CRYPTO: client sessions hold a X25519 keypair for the session duration so the session
// can be a member of conversation_keys.wrapped_keys entries. The private key is produced
// inside the portal bundle and never sent to the server.
import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { auditRepo } from '../repositories/audit.js';
import {
  findIdentityByIdentifier,
  issueAccessCode,
  verifyAccessCode,
  normalizePhone,
  hashSessionToken,
  newSessionToken,
} from '../services/accessCodes.js';
import { getEmailProvider } from '../bridges/email/index.js';
import { getSmsProvider } from '../bridges/sms/index.js';

export const portalRouter = Router();

const SESSION_COOKIE = 'vibe.portal';

const identifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: env.rateLimitPortalCodePer10Min,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

// -------- Identify: send an access code --------

const identifySchema = z.object({
  identifier: z.string().min(3).max(255),
});

portalRouter.post(
  '/identify',
  identifyLimiter,
  asyncHandler(async (req, res) => {
    const parsed = identifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const identity = await findIdentityByIdentifier(parsed.data.identifier);
    if (identity) {
      try {
        const isEmail = parsed.data.identifier.includes('@');
        const via = isEmail || !identity.phone ? 'email' : 'sms';
        const { code } = await issueAccessCode(identity, via);
        if (via === 'email') {
          await getEmailProvider().send({
            to: identity.email,
            subject: 'Your Vibe Connect access code',
            text: `Your code is: ${code}\nExpires in 10 minutes.\nOpen: ${env.portalUrl}`,
          });
        } else {
          await getSmsProvider().sendMessage({
            to: identity.phone!,
            body: `Vibe Connect code: ${code} (10 min). Reply STOP to opt out.`,
          });
        }
      } catch {
        /* swallow to keep responses indistinguishable */
      }
    }
    // Always same response — do not reveal whether the identifier matched.
    res.json({ ok: true, sent: true });
  }),
);

// -------- Verify code + issue session --------

const verifySchema = z.object({
  identifier: z.string().min(3).max(255),
  code: z.string().length(6),
  sessionPublicKey: z.string().min(1).max(256), // base64 X25519 pubkey from the client
});

portalRouter.post(
  '/verify',
  identifyLimiter,
  asyncHandler(async (req, res) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const identity = await findIdentityByIdentifier(parsed.data.identifier);
    if (!identity) {
      // Consume the same rough timing as a real bcrypt compare.
      await bcrypt.compare(parsed.data.code, '$2a$10$' + '0'.repeat(53));
      res.status(401).json({ error: 'invalid' });
      return;
    }
    const result = await verifyAccessCode(identity, parsed.data.code);
    if (!result.ok) {
      res.status(401).json({ error: 'invalid', reason: result.reason });
      return;
    }
    const token = newSessionToken();
    const tokenHash = hashSessionToken(token);
    const expires = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8h absolute
    const rawUa = (req.headers['user-agent'] as string | undefined) ?? null;
    const [row] = await db('client_sessions')
      .insert({
        external_identity_id: identity.id,
        session_token_hash: tokenHash,
        absolute_expires_at: expires,
        user_agent: rawUa ? rawUa.slice(0, 255) : null,
        ip_address: req.ip ?? null,
        session_public_key: parsed.data.sessionPublicKey,
      })
      .returning(['id']);

    await auditRepo.write({
      actorExternalIdentityId: identity.id,
      action: 'portal.login',
      targetType: 'client_session',
      targetId: row!.id,
    });

    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: env.sessionSecure,
      sameSite: env.sessionSameSite,
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({
      ok: true,
      sessionId: row!.id,
      verificationRequired:
        identity.verification_required && Boolean(identity.verification_last4_hash),
      verificationType: identity.verification_type,
    });
  }),
);

// -------- Step-up verification --------

const stepupSchema = z.object({
  last4: z.string().regex(/^\d{4}$/),
});

const stepupLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

portalRouter.post(
  '/stepup',
  stepupLimiter,
  asyncHandler(async (req, res) => {
    const session = await loadSessionFromCookie(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const identity = await db<{
      id: string;
      verification_last4_hash: string | null;
      verification_required: boolean;
    }>('external_identities')
      .where({ id: session.external_identity_id })
      .first();
    if (!identity?.verification_last4_hash) {
      res.status(400).json({ error: 'no_verification_configured' });
      return;
    }
    const parsed = stepupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    // Attempt cap: 3 failures → invalidate session. STEPUP.
    const ok = await bcrypt.compare(parsed.data.last4, identity.verification_last4_hash);
    if (!ok) {
      const attempts = session.stepup_attempts + 1;
      if (attempts >= 3) {
        await db('client_sessions')
          .where({ id: session.id })
          .update({ revoked_at: db.fn.now(), stepup_attempts: attempts });
        await auditRepo.write({
          actorExternalIdentityId: session.external_identity_id,
          action: 'portal.stepup_locked',
          targetType: 'client_session',
          targetId: session.id,
        });
        res.clearCookie(SESSION_COOKIE);
        res.status(401).json({ error: 'session_revoked' });
        return;
      }
      await db('client_sessions').where({ id: session.id }).update({ stepup_attempts: attempts });
      res.status(401).json({ error: 'mismatch', remaining: 3 - attempts });
      return;
    }
    const settings = await db('firm_settings').where({ id: 1 }).first();
    const timeoutHours = Number(settings?.stepup_timeout_hours ?? 24);
    const verifiedUntil =
      timeoutHours === -1 ? null : new Date(Date.now() + timeoutHours * 60 * 60 * 1000);
    // On success, reset attempts so future step-ups (after timeout) start fresh.
    await db('client_sessions')
      .where({ id: session.id })
      .update({ verified_until: verifiedUntil, stepup_attempts: 0 });
    await auditRepo.write({
      actorExternalIdentityId: session.external_identity_id,
      action: 'portal.stepup_verified',
      targetType: 'client_session',
      targetId: session.id,
    });
    res.json({ ok: true, verifiedUntil });
  }),
);

portalRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const session = await loadSessionFromCookie(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const identity = await db('external_identities')
      .where({ id: session.external_identity_id })
      .first();
    res.json({
      session: {
        id: session.id,
        verifiedUntil: session.verified_until,
      },
      identity: identity && {
        id: identity.id,
        displayName: identity.display_name,
        email: identity.email,
        phone: identity.phone,
        verificationRequired: identity.verification_required,
        verificationType: identity.verification_type,
        hasVerification: Boolean(identity.verification_last4_hash),
      },
    });
  }),
);

portalRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const session = await loadSessionFromCookie(req);
    if (session) {
      await db('client_sessions').where({ id: session.id }).update({ revoked_at: db.fn.now() });
      await auditRepo.write({
        actorExternalIdentityId: session.external_identity_id,
        action: 'portal.logout',
        targetType: 'client_session',
        targetId: session.id,
      });
    }
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  }),
);

export interface PortalSession {
  id: string;
  external_identity_id: string;
  verified_until: string | null;
  user_agent: string | null;
  session_public_key: string | null;
  stepup_attempts: number;
}

async function loadSessionFromCookie(req: Request): Promise<PortalSession | null> {
  const raw = req.cookies[SESSION_COOKIE] as string | undefined;
  if (!raw) return null;
  const tokenHash = hashSessionToken(raw);
  const session = await db('client_sessions')
    .where({ session_token_hash: tokenHash })
    .whereNull('revoked_at')
    .where('absolute_expires_at', '>', db.fn.now())
    .first();
  if (!session) return null;
  await db('client_sessions').where({ id: session.id }).update({ last_seen_at: db.fn.now() });
  return {
    id: session.id,
    external_identity_id: session.external_identity_id,
    verified_until: session.verified_until,
    user_agent: session.user_agent,
    session_public_key: session.session_public_key,
    stepup_attempts: Number(session.stepup_attempts ?? 0),
  };
}

export { loadSessionFromCookie, normalizePhone };
