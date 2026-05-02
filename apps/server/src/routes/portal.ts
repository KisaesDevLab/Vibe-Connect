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
  recentVerifyAttemptsForIdentity,
  isVerifyLockedForIdentity,
  recentStepupLockoutsForIdentity,
  isStepupLockedForIdentity,
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
    // Firm-wide client-messaging kill switch. When disabled, treat every identifier
    // as if it didn't match — response is identical so the feature-disabled state
    // isn't leaked to an outsider probing the portal.
    const settings = await db('firm_settings').where({ id: 1 }).first();
    const messagingEnabled = Boolean(settings?.client_messaging_enabled ?? true);
    const identity = messagingEnabled
      ? await findIdentityByIdentifier(parsed.data.identifier)
      : null;
    // Deactivated identities silently get no code. Response stays indistinguishable
    // from the unmatched-identifier case so the status isn't leaked.
    if (identity && !identity.deactivated_at) {
      try {
        const isEmail = parsed.data.identifier.includes('@');
        const via = isEmail || !identity.phone ? 'email' : 'sms';
        const { code } = await issueAccessCode(identity, via);
        if (via === 'email') {
          const emailProvider = await getEmailProvider();
          await emailProvider.send({
            to: identity.email,
            subject: 'Your Vibe Connect access code',
            text: `Your code is: ${code}\nExpires in 10 minutes.\nOpen: ${env.portalUrl}`,
          });
        } else {
          const smsProvider = await getSmsProvider();
          await smsProvider.sendMessage({
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
    const settings = await db('firm_settings').where({ id: 1 }).first();
    if (!(settings?.client_messaging_enabled ?? true)) {
      // Same shape + timing as invalid-code so the toggle state isn't leaked.
      await bcrypt.compare(parsed.data.code, '$2a$10$' + '0'.repeat(53));
      res.status(401).json({ error: 'invalid' });
      return;
    }
    const identity = await findIdentityByIdentifier(parsed.data.identifier);
    if (!identity) {
      // Consume the same rough timing as a real bcrypt compare.
      await bcrypt.compare(parsed.data.code, '$2a$10$' + '0'.repeat(53));
      res.status(401).json({ error: 'invalid' });
      return;
    }
    // Per-identity brute-force cap. The per-code 5-attempt lockout (in
    // verifyAccessCode) stops a single attacker hammering one code, but a
    // distributed attacker can rotate IPs across multiple issued codes. This
    // sum-across-codes cap refuses to let the identity absorb more than
    // VERIFY_ATTEMPTS_PER_IDENTITY_PER_HOUR wrong-guesses in a rolling
    // window regardless of which IP or code is being hit.
    const recentAttempts = await recentVerifyAttemptsForIdentity(identity.id);
    if (isVerifyLockedForIdentity(recentAttempts)) {
      await bcrypt.compare(parsed.data.code, '$2a$10$' + '0'.repeat(53));
      await auditRepo.write({
        actorExternalIdentityId: identity.id,
        action: 'portal.verify_identity_locked',
        targetType: 'external_identity',
        targetId: identity.id,
        details: { attemptsInHour: recentAttempts },
      });
      res.status(429).json({ error: 'identity_locked' });
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
      // Distribution mode: scope to BASE_PATH so a sibling Vibe app on the
      // same host can't read the portal cookie (single-app: '/'; multi-app:
      // '/connect'). clearCookie below uses the same path so logout works
      // regardless of mode.
      path: env.sessionCookiePath,
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

// -------- Invite acceptance — first portal visit via the invite URL --------
//
// Flow:
//   URL: /invite?id=<uuid>&t=<base64url 32 bytes>
//   Portal extracts the token, derives keypair from token[16:32] client-side,
//   POSTs { externalIdentityId, tokenIdBase64, sessionPublicKey } here.
// Server verifies bcrypt(tokenIdBase64) against external_identities.invite_token_hash,
// issues a client_session using the derived session_public_key, then INVALIDATES
// the invite token (consumed). Future logins use the standard access-code flow.
const inviteAcceptSchema = z.object({
  externalIdentityId: z.string().uuid(),
  tokenIdBase64: z.string().min(1).max(64),
  sessionPublicKey: z.string().min(1).max(256),
});

portalRouter.post(
  '/invite-accept',
  identifyLimiter,
  asyncHandler(async (req, res) => {
    const parsed = inviteAcceptSchema.safeParse(req.body);
    if (!parsed.success) {
      // Consume similar timing to the bcrypt path.
      await bcrypt.compare('x', '$2a$10$' + '0'.repeat(53));
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const identity = await db('external_identities')
      .where({ id: parsed.data.externalIdentityId })
      .first();
    if (!identity || !identity.invite_token_hash || identity.deactivated_at) {
      await bcrypt.compare('x', '$2a$10$' + '0'.repeat(53));
      res.status(401).json({ error: 'invalid' });
      return;
    }
    const ok = await bcrypt.compare(parsed.data.tokenIdBase64, identity.invite_token_hash);
    if (!ok) {
      res.status(401).json({ error: 'invalid' });
      return;
    }
    // The client's derived public key must match what the server computed at
    // invite time. Protects against a portal bug accidentally using the wrong
    // seed — the sealed conversation keys would otherwise be unreadable.
    if (parsed.data.sessionPublicKey !== identity.invite_public_key) {
      res.status(400).json({ error: 'public_key_mismatch' });
      return;
    }
    const token = newSessionToken();
    const tokenHash = hashSessionToken(token);
    const expires = new Date(Date.now() + 8 * 60 * 60 * 1000);
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
    // Invalidate the invite — one-shot. Keep invite_public_key so conversations
    // wrapped to it remain readable; the session's private key (known to this
    // browser) still unwraps them.
    await db('external_identities').where({ id: identity.id }).update({
      invite_token_hash: null,
      last_active_at: db.fn.now(),
    });
    await auditRepo.write({
      actorExternalIdentityId: identity.id,
      action: 'portal.invite_accepted',
      targetType: 'client_session',
      targetId: row!.id,
    });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      // Distribution mode: scope to BASE_PATH so a sibling Vibe app on the
      // same host can't read the portal cookie (single-app: '/'; multi-app:
      // '/connect'). clearCookie below uses the same path so logout works
      // regardless of mode.
      path: env.sessionCookiePath,
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
    // Per-identity step-up lockout. The per-session 3-strikes gate already
    // revokes the single session it trips on, but a distributed attacker can
    // rotate through fresh sessions indefinitely. We count how many of this
    // identity's sessions have been step-up-locked in the last 24 h and
    // refuse to let more sessions go down the gauntlet once the identity has
    // absorbed STEPUP_LOCKOUTS_PER_IDENTITY_PER_DAY revocations. The target
    // client can still sign in and issue fresh access codes — they just can't
    // be step-up-verified until the window rolls off.
    const lockouts = await recentStepupLockoutsForIdentity(identity.id);
    if (isStepupLockedForIdentity(lockouts)) {
      // Don't bcrypt-equalise here — we've already committed to refusing on
      // the count, and rate-limiting the attacker further is more valuable
      // than the 50 ms of timing parity.
      await auditRepo.write({
        actorExternalIdentityId: session.external_identity_id,
        action: 'portal.stepup_identity_locked',
        targetType: 'external_identity',
        targetId: session.external_identity_id,
        details: { lockoutsInDay: lockouts },
      });
      res.status(429).json({ error: 'identity_locked' });
      return;
    }
    // Per-session attempt cap: 3 failures → invalidate session. STEPUP.
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
        res.clearCookie(SESSION_COOKIE, { path: env.sessionCookiePath });
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
    // Rotate the session token on successful step-up. If an attacker captured
    // the pre-verification cookie (prior shared machine, earlier XSS that's
    // since been patched, etc.), they inherited the post-verification state
    // without ever passing the SSN/EIN check. Minting a fresh token and
    // revoking the old one in one transaction closes that replay window.
    const newToken = newSessionToken();
    const newHash = hashSessionToken(newToken);
    await db.transaction(async (trx) => {
      // Revoke the old row and create a fresh one carrying verified_until.
      // We keep the same external_identity + session_public_key so wrapped
      // conversation keys remain valid for the same X25519 pair.
      const [oldRow] = await trx('client_sessions')
        .where({ id: session.id })
        .update({ revoked_at: trx.fn.now(), stepup_attempts: 0 })
        .returning(['absolute_expires_at', 'session_public_key', 'user_agent', 'ip_address']);
      await trx('client_sessions').insert({
        external_identity_id: session.external_identity_id,
        session_token_hash: newHash,
        absolute_expires_at: oldRow.absolute_expires_at,
        verified_until: verifiedUntil,
        user_agent: oldRow.user_agent,
        ip_address: oldRow.ip_address,
        session_public_key: oldRow.session_public_key,
      });
    });
    await auditRepo.write({
      actorExternalIdentityId: session.external_identity_id,
      action: 'portal.stepup_verified',
      targetType: 'client_session',
      targetId: session.id,
    });
    res.cookie(SESSION_COOKIE, newToken, {
      httpOnly: true,
      path: env.sessionCookiePath,
      secure: env.sessionSecure,
      sameSite: env.sessionSameSite,
      // Keep the same remaining lifetime as the absolute_expires_at on the
      // old row — maxAge is the browser cookie expiry, not the session's
      // absolute cap.
      maxAge: 8 * 60 * 60 * 1000,
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
    res.clearCookie(SESSION_COOKIE, { path: env.sessionCookiePath });
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

/**
 * Coarse UA family — browser engine class only. Full user-agent strings are
 * too noisy to pin on (minor version bumps drift), but the engine/OS major
 * typically stays stable for a session. If this function returns `null` we
 * skip the check rather than reject the request.
 */
function uaFamily(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const s = ua.toLowerCase();
  // Order matters: Edge/Opera/Brave present as Chrome too.
  if (s.includes('edg/')) return 'edge';
  if (s.includes('opr/') || s.includes('opera')) return 'opera';
  if (s.includes('firefox/')) return 'firefox';
  if (s.includes('chrome/')) return 'chrome';
  if (s.includes('safari/')) return 'safari';
  return null;
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
  // Bind the session to the UA family captured at login. Full-UA pinning
  // would churn on browser auto-updates; the family (chrome/firefox/safari/
  // edge/opera) is stable for a session. IP pinning is deliberately omitted
  // here — mobile clients roam between WiFi/cellular and pinning would log
  // them out mid-use. A UA-family drift is rare enough to warrant revoking
  // the session and forcing a fresh verify flow; we audit-log the drift so
  // anything suspicious surfaces in admin review.
  const sessionUaFamily = uaFamily(session.user_agent);
  const currentUaFamily = uaFamily((req.headers['user-agent'] as string | undefined) ?? null);
  if (sessionUaFamily && currentUaFamily && sessionUaFamily !== currentUaFamily) {
    await db('client_sessions').where({ id: session.id }).update({ revoked_at: db.fn.now() });
    await auditRepo.write({
      actorExternalIdentityId: session.external_identity_id,
      action: 'portal.session_ua_drift_revoked',
      targetType: 'client_session',
      targetId: session.id,
      details: { fromFamily: sessionUaFamily, toFamily: currentUaFamily },
      ipAddress: req.ip ?? null,
    });
    return null;
  }
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
