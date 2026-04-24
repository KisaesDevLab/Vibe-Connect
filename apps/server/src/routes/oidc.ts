// Generic OpenID Connect sign-in. Works with any OIDC provider (Google, Microsoft Entra,
// Okta, Auth0, Keycloak, self-hosted) via issuer discovery + Authorization-Code-with-PKCE.
//
// CRYPTO NOTE: OIDC only authenticates *who* you are. Device-key enrollment still
// requires a user-controlled passphrase on first enrollment, because the private key
// that wraps conversation keys must not be derivable from anything the OIDC provider
// (or this server) sees. The Enrollment page asks for that passphrase after the user
// lands back from the provider.
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { generators, Issuer, type Client, type TokenSet } from 'openid-client';
import { env } from '../env.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { auditRepo } from '../repositories/audit.js';
import { usersRepo } from '../repositories/users.js';
import { logger } from '../logger.js';

export const oidcRouter = Router();

// Brute-force and replay protection on the callback path. `openid-client` checks
// state/nonce/PKCE already — this just caps how quickly a script can burn attempts.
const oidcCallbackLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});
const oidcLoginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

declare module 'express-session' {
  interface SessionData {
    oidcState?: string;
    oidcNonce?: string;
    oidcCodeVerifier?: string;
  }
}

let clientPromise: Promise<Client | null> | null = null;

function oidcConfigured(): boolean {
  return Boolean(
    env.oidcIssuerUrl && env.oidcClientId && env.oidcClientSecret && env.oidcRedirectUri,
  );
}

/**
 * SSRF guard for the OIDC issuer URL. `Issuer.discover` will happily fetch
 * whatever URL it's handed — including internal metadata endpoints like
 * 169.254.169.254 on AWS or link-local services on a LAN. We reject obviously
 * dangerous targets at the URL level before the first network call so an
 * operator who mistypes or paste-fails cannot turn the appliance into a probe
 * into the surrounding infrastructure.
 *
 * NOTE: This does not defend against DNS rebinding — a public hostname could
 * resolve to an internal IP at fetch time. That's a deeper fix (custom HTTP
 * agent rejecting private IPs on socket connect) and is tracked separately.
 */
export function validateIssuerUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  // Allow https everywhere; http only in non-prod so dev stacks with a local
  // Keycloak on http://localhost:8080 still work. In prod, http is refused.
  if (u.protocol !== 'https:' && !(env.nodeEnv !== 'production' && u.protocol === 'http:')) {
    return { ok: false, reason: 'must be https (http allowed only in non-production)' };
  }
  const host = u.hostname.toLowerCase();
  // Block hostnames that are load-bearing for SSRF attacks regardless of DNS.
  // localhost / metadata endpoints / wildcards / empty hosts.
  if (!host) return { ok: false, reason: 'empty hostname' };
  if (host === 'localhost' || host === 'localhost.localdomain') {
    return { ok: false, reason: 'localhost is not an allowed issuer host' };
  }
  if (
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host === 'metadata.goog'
  ) {
    return { ok: false, reason: 'cloud metadata hostnames are blocked' };
  }
  // IPv4 literal: block loopback, RFC1918, link-local, 0.0.0.0.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [, a, b] = v4.map(Number) as [number, number, number, number, number];
    if (a === 127 || a === 10 || a === 0) {
      return { ok: false, reason: 'private / loopback IPv4 address' };
    }
    if (a === 169 && b === 254) {
      return { ok: false, reason: 'link-local IPv4 (169.254.0.0/16) is blocked (AWS/GCP metadata)' };
    }
    if (a === 172 && b! >= 16 && b! <= 31) {
      return { ok: false, reason: 'private IPv4 (172.16.0.0/12)' };
    }
    if (a === 192 && b === 168) {
      return { ok: false, reason: 'private IPv4 (192.168.0.0/16)' };
    }
  }
  // IPv6 literal: URL wraps in brackets. Block loopback, unique-local, link-local.
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1).toLowerCase();
    if (v6 === '::1' || v6 === '::') {
      return { ok: false, reason: 'IPv6 loopback/unspecified address' };
    }
    // fc00::/7 unique local, fe80::/10 link-local — quick prefix checks.
    if (v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) {
      return { ok: false, reason: 'IPv6 private / link-local address' };
    }
  }
  return { ok: true };
}

async function getClient(): Promise<Client | null> {
  if (!oidcConfigured()) return null;
  const check = validateIssuerUrl(env.oidcIssuerUrl);
  if (!check.ok) {
    // Log once per process — the clientPromise cache means we're typically
    // called often; logging every call would drown the signal.
    if (!clientPromise) {
      logger.warn('oidc.issuer_url_rejected', {
        reason: check.reason,
        // Don't log the URL itself — it might contain a tenant-scoped path
        // an operator would rather not have in appliance logs.
      });
      clientPromise = Promise.resolve(null);
    }
    return clientPromise;
  }
  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const issuer = await Issuer.discover(env.oidcIssuerUrl);
        return new issuer.Client({
          client_id: env.oidcClientId,
          client_secret: env.oidcClientSecret,
          redirect_uris: [env.oidcRedirectUri],
          response_types: ['code'],
        });
      } catch (err) {
        logger.warn('oidc.discovery_failed', { err: err instanceof Error ? err.message : String(err) });
        // Reset so a later retry can reattempt discovery.
        clientPromise = null;
        return null;
      }
    })();
  }
  return clientPromise;
}

oidcRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    const client = await getClient();
    res.json({
      enabled: Boolean(client),
      loginUrl: client ? '/auth/oidc/login' : null,
    });
  }),
);

oidcRouter.get(
  '/login',
  oidcLoginLimiter,
  asyncHandler(async (req, res) => {
    const client = await getClient();
    if (!client) {
      res.status(503).json({ error: 'oidc_not_configured' });
      return;
    }
    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    req.session.oidcState = state;
    req.session.oidcNonce = nonce;
    req.session.oidcCodeVerifier = codeVerifier;
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
    const url = client.authorizationUrl({
      scope: env.oidcScopes,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    res.redirect(url);
  }),
);

oidcRouter.get(
  '/callback',
  oidcCallbackLimiter,
  asyncHandler(async (req, res) => {
    const client = await getClient();
    if (!client) {
      res.status(503).send('OIDC not configured.');
      return;
    }
    const state = req.session.oidcState;
    const nonce = req.session.oidcNonce;
    const codeVerifier = req.session.oidcCodeVerifier;
    if (!state || !nonce || !codeVerifier) {
      res.status(400).send('Missing OIDC state — please try signing in again.');
      return;
    }
    let tokens: TokenSet;
    try {
      const params = client.callbackParams(req);
      tokens = await client.callback(env.oidcRedirectUri, params, {
        state,
        nonce,
        code_verifier: codeVerifier,
      });
    } catch (err) {
      logger.warn('oidc.callback_failed', { err: err instanceof Error ? err.message : String(err) });
      res.status(400).send('OIDC sign-in failed. Please try again.');
      return;
    }
    const claims = tokens.claims();
    const sub = claims.sub;
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
    const name =
      (typeof claims.name === 'string' ? claims.name : null) ??
      (typeof claims.preferred_username === 'string' ? claims.preferred_username : null) ??
      email ??
      sub;
    if (!email) {
      res.status(400).send('OIDC provider did not return an email claim. Contact your admin.');
      return;
    }

    // JIT-provision: match on email, create if absent. OIDC users have no local password,
    // so we store a random bcrypt hash that cannot authenticate via the standard /auth/login
    // route. (bcrypt.compare against anything will always return false.)
    let user = await usersRepo.findByEmail(email);
    const adminFromClaim =
      env.oidcAdminClaim &&
      env.oidcAdminClaimValue &&
      typeof claims[env.oidcAdminClaim] !== 'undefined' &&
      (Array.isArray(claims[env.oidcAdminClaim])
        ? (claims[env.oidcAdminClaim] as unknown[]).includes(env.oidcAdminClaimValue)
        : claims[env.oidcAdminClaim] === env.oidcAdminClaimValue);
    if (!user) {
      const randomPw = randomBytes(48).toString('hex');
      const hash = await bcrypt.hash(randomPw, 12);
      user = await usersRepo.create({
        username: slugifyUsername(email, sub),
        email,
        passwordHash: hash,
        displayName: name,
        isAdmin: Boolean(adminFromClaim),
      });
      await auditRepo.write({
        actorUserId: user.id,
        action: 'auth.oidc_user_created',
        targetType: 'user',
        targetId: user.id,
        details: { email, issuer: env.oidcIssuerUrl, isAdmin: user.is_admin },
        ipAddress: req.ip ?? null,
      });
    } else if (adminFromClaim && !user.is_admin) {
      await usersRepo.update(user.id, { is_admin: true });
    }
    if (!user.is_active) {
      res.status(403).send('This account is deactivated.');
      return;
    }

    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.userId = user.id;
    req.session.isAdmin = user.is_admin;
    req.session.username = user.username;
    delete req.session.oidcState;
    delete req.session.oidcNonce;
    delete req.session.oidcCodeVerifier;
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );

    await auditRepo.write({
      actorUserId: user.id,
      action: 'auth.oidc_login',
      targetType: 'user',
      targetId: user.id,
      details: { email },
      ipAddress: req.ip ?? null,
    });

    // Send them to the staff app. Enrollment still prompts for a device passphrase.
    res.redirect(env.siteUrl + '/');
  }),
);

function slugifyUsername(email: string, sub: string): string {
  const base = email.split('@')[0] ?? sub;
  const safe = base.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 56);
  // Suffix with a short sub-hash to avoid collisions if two users share a local-part.
  const suffix = sub.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'sso';
  return `${safe || 'sso'}.${suffix}`.slice(0, 64);
}
