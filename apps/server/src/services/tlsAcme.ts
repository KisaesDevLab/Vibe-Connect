// ACME (Let's Encrypt) certificate issuance + renewal for the appliance.
//
// Flow
// ----
// 1. Admin POSTs /admin/tls/request.
// 2. This module reads the staff + portal hostnames, ACME email, and
//    environment from firm_settings; generates (or unseals) the ACME
//    account key; asks acme-client to run auto() against LE's directory.
// 3. auto() creates the order, offers an HTTP-01 challenge. Our
//    challengeCreateFn stashes the token → key-authorization mapping in
//    an in-memory Map; the public Express route
//    /.well-known/acme-challenge/:token reads from that Map and returns
//    the key-authorization as text/plain. LE validates, the cert issues,
//    and we write the PEM + key to env.tlsOutputDir/{connect,portal}.{crt,key}.
// 4. nginx is watching that directory with inotifywait and reloads itself.
//
// Files written (all the same cert content — one multi-SAN cert covering
// both hostnames, duplicated so the stock nginx.conf's two listeners don't
// need rewiring):
//   connect.crt / connect.key — staff site (port 443)
//   portal.crt  / portal.key  — client portal (port 8443)
//
// Concurrency: startAcmeOrder is guarded by `inFlight` so two admins
// clicking "Request" simultaneously can't race two LE orders. inFlight is
// exported so the /admin/tls/status endpoint can surface the state.
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import acme from 'acme-client';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { auditRepo } from '../repositories/audit.js';
import { sealString, unsealString } from './kekSeal.js';

// --------------- Challenge strategies ---------------

interface ChallengeStrategy {
  kind: 'http-01' | 'dns-01';
  provision: NonNullable<Parameters<acme.Client['auto']>[0]['challengeCreateFn']>;
  cleanup: NonNullable<Parameters<acme.Client['auto']>[0]['challengeRemoveFn']>;
  priority: string[];
}

// In-memory token → key-authorization map. acme-client hands us the
// key-authorization during challengeCreateFn; the HTTP responder reads it
// back by token. Map lives only as long as the order is in flight — a
// process restart kills it, which is the correct failure mode (an
// orphaned order should fail, not dangle).
const http01Tokens = new Map<string, string>();

export function getHttp01KeyAuthorization(token: string): string | null {
  return http01Tokens.get(token) ?? null;
}

const http01Strategy: ChallengeStrategy = {
  kind: 'http-01',
  priority: ['http-01'],
  provision: async (_authz, challenge, keyAuthorization) => {
    if (challenge.type !== 'http-01') return;
    http01Tokens.set(challenge.token, keyAuthorization);
  },
  cleanup: async (_authz, challenge) => {
    if (challenge.type !== 'http-01') return;
    http01Tokens.delete(challenge.token);
  },
};

// Phase 2 slot: this service already accepts a challengeType parameter;
// when dns01Strategy lands, pickStrategy switches on it.
function pickStrategy(kind: 'http-01' | 'dns-01'): ChallengeStrategy {
  if (kind === 'http-01') return http01Strategy;
  throw new Error(`challenge_type_not_implemented: ${kind}`);
}

// --------------- State + types ---------------

interface AcmeConfigRow {
  tls_staff_domain: string | null;
  tls_portal_domain: string | null;
  tls_acme_email: string | null;
  tls_acme_environment: 'staging' | 'production';
  tls_challenge_type: 'http-01' | 'dns-01';
  tls_acme_account_key_sealed: string | null;
  tls_cert_subject: string | null;
  tls_cert_issuer: string | null;
  tls_cert_expires_at: Date | string | null;
  tls_cert_requested_at: Date | string | null;
  tls_last_error: string | null;
}

export interface TlsCertInfo {
  subject: string;
  issuer: string;
  expiresAt: string;
  daysUntilExpiry: number;
  hostnames: string[];
}

export interface TlsStatus {
  config: {
    staffDomain: string | null;
    portalDomain: string | null;
    acmeEmail: string | null;
    acmeEnvironment: 'staging' | 'production';
    challengeType: 'http-01' | 'dns-01';
    accountKeyConfigured: boolean;
  };
  cert: TlsCertInfo | null;
  lastError: string | null;
  inFlight: boolean;
  requestedAt: string | null;
}

let inFlight = false;
export function isOrderInFlight(): boolean {
  return inFlight;
}

// --------------- Public API ---------------

async function loadConfig(): Promise<AcmeConfigRow> {
  const row = (await db('firm_settings').where({ id: 1 }).first()) as unknown as AcmeConfigRow;
  return row;
}

function directoryUrlFor(env_: 'staging' | 'production'): string {
  return env_ === 'production' ? env.acmeDirectoryProduction : env.acmeDirectoryStaging;
}

async function loadOrCreateAccountKey(cfg: AcmeConfigRow): Promise<Buffer> {
  if (cfg.tls_acme_account_key_sealed) {
    const pem = await unsealString(cfg.tls_acme_account_key_sealed);
    return Buffer.from(pem, 'utf8');
  }
  const key = await acme.crypto.createPrivateKey();
  const sealed = await sealString(key.toString('utf8'));
  await db('firm_settings').where({ id: 1 }).update({ tls_acme_account_key_sealed: sealed });
  return key;
}

async function writeCertBundle(certPem: string, keyPem: Buffer | string): Promise<void> {
  await fs.mkdir(env.tlsOutputDir, { recursive: true });
  const pairs: Array<[string, Buffer | string]> = [
    ['connect.crt', certPem],
    ['connect.key', keyPem],
    ['portal.crt', certPem],
    ['portal.key', keyPem],
  ];
  // Write each file atomically via a .tmp + rename so nginx's inotify loop
  // never sees a half-written cert. Rename is atomic on POSIX.
  for (const [name, contents] of pairs) {
    const final = path.join(env.tlsOutputDir, name);
    const tmp = `${final}.tmp`;
    await fs.writeFile(tmp, contents, { mode: 0o600 });
    await fs.rename(tmp, final);
  }
}

function parseCertMetadata(certPem: string): { subject: string; issuer: string; expiresAt: Date } {
  const x = new X509Certificate(certPem);
  return {
    subject: x.subject,
    issuer: x.issuer,
    expiresAt: new Date(x.validTo),
  };
}

export async function getCertInfo(): Promise<TlsCertInfo | null> {
  const connectCrt = path.join(env.tlsOutputDir, 'connect.crt');
  let pem: string;
  try {
    pem = await fs.readFile(connectCrt, 'utf8');
  } catch {
    return null;
  }
  try {
    const x = new X509Certificate(pem);
    const expiresAt = new Date(x.validTo);
    const daysUntilExpiry = Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000);
    const sans = (x.subjectAltName ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^DNS:/, ''))
      .filter(Boolean);
    return {
      subject: x.subject,
      issuer: x.issuer,
      expiresAt: expiresAt.toISOString(),
      daysUntilExpiry,
      hostnames: sans,
    };
  } catch (err) {
    logger.warn('tls_cert_parse_failed', { msg: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function getStatus(): Promise<TlsStatus> {
  const cfg = await loadConfig();
  const cert = await getCertInfo();
  return {
    config: {
      staffDomain: cfg.tls_staff_domain,
      portalDomain: cfg.tls_portal_domain,
      acmeEmail: cfg.tls_acme_email,
      acmeEnvironment: cfg.tls_acme_environment,
      challengeType: cfg.tls_challenge_type,
      accountKeyConfigured: Boolean(cfg.tls_acme_account_key_sealed),
    },
    cert,
    lastError: cfg.tls_last_error,
    inFlight,
    requestedAt: cfg.tls_cert_requested_at
      ? new Date(cfg.tls_cert_requested_at as Date | string).toISOString()
      : null,
  };
}

export interface RunAcmeOrderOpts {
  actorUserId: string | null;
  force?: boolean; // force renewal even if cert is not near expiry
}

/**
 * Run an ACME order for the currently-configured domains. Returns once the
 * cert is issued and written to disk. Async-safe: concurrent calls while
 * one is already in flight fast-fail with order_in_flight.
 */
export async function runAcmeOrder(opts: RunAcmeOrderOpts): Promise<void> {
  if (inFlight) throw new Error('order_in_flight');
  inFlight = true;
  const startedAt = new Date();
  try {
    const cfg = await loadConfig();
    const staff = (cfg.tls_staff_domain ?? '').trim();
    const portal = (cfg.tls_portal_domain ?? '').trim();
    const email = (cfg.tls_acme_email ?? '').trim();
    if (!staff || !email) {
      throw new Error('tls_config_incomplete');
    }
    const domains = portal && portal !== staff ? [staff, portal] : [staff];
    const challengeKind: 'http-01' | 'dns-01' = cfg.tls_challenge_type ?? 'http-01';
    const strategy = pickStrategy(challengeKind);

    const accountKey = await loadOrCreateAccountKey(cfg);
    const client = new acme.Client({
      directoryUrl: directoryUrlFor(cfg.tls_acme_environment ?? 'staging'),
      accountKey,
    });

    const [certPrivateKey, csr] = await acme.crypto.createCsr({
      commonName: domains[0]!,
      altNames: domains,
    });

    await db('firm_settings').where({ id: 1 }).update({
      tls_cert_requested_at: startedAt.toISOString(),
      tls_last_error: null,
    });

    const certPem = await client.auto({
      csr,
      email,
      termsOfServiceAgreed: true,
      challengePriority: strategy.priority,
      challengeCreateFn: strategy.provision,
      challengeRemoveFn: strategy.cleanup,
    });

    await writeCertBundle(certPem, certPrivateKey);
    const meta = parseCertMetadata(certPem);
    await db('firm_settings').where({ id: 1 }).update({
      tls_cert_subject: meta.subject,
      tls_cert_issuer: meta.issuer,
      tls_cert_expires_at: meta.expiresAt.toISOString(),
      tls_last_error: null,
    });
    await auditRepo.write({
      actorUserId: opts.actorUserId ?? undefined,
      action: opts.force ? 'admin.tls_renewed' : 'admin.tls_requested',
      targetType: 'firm_settings',
      details: {
        domains,
        environment: cfg.tls_acme_environment,
        challengeType: challengeKind,
        expiresAt: meta.expiresAt.toISOString(),
      },
    });
    logger.info('tls.cert_issued', {
      domains,
      environment: cfg.tls_acme_environment,
      expiresAt: meta.expiresAt.toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Strip anything that looks like a PEM or JWK blob from the surfaced
    // message — we never want private key bytes in tls_last_error / audit.
    const scrubbed = msg.replace(/-----BEGIN[\s\S]+?-----END[^-]*-----/g, '[pem redacted]');
    await db('firm_settings')
      .where({ id: 1 })
      .update({ tls_last_error: scrubbed.slice(0, 2000) });
    logger.error('tls.cert_order_failed', { msg: scrubbed });
    throw err;
  } finally {
    inFlight = false;
  }
}

/**
 * Idempotent daily renewal. No-op when cert is either absent (admin hasn't
 * requested one yet) or >30 days from expiry. `force: true` bypasses the
 * threshold check so the admin's "Renew now" button goes through.
 */
export async function renewIfExpiring(opts: {
  actorUserId: string | null;
  force?: boolean;
}): Promise<{ renewed: boolean; reason?: string }> {
  const cert = await getCertInfo();
  if (!cert) return { renewed: false, reason: 'no_cert' };
  if (!opts.force && cert.daysUntilExpiry > 30) {
    return { renewed: false, reason: 'not_due' };
  }
  await runAcmeOrder({ actorUserId: opts.actorUserId, force: true });
  return { renewed: true };
}

/** Revoke (best-effort) + delete on-disk cert files + clear DB metadata. */
export async function revokeAndWipe(actorUserId: string | null): Promise<void> {
  const cfg = await loadConfig();
  const connectCrt = path.join(env.tlsOutputDir, 'connect.crt');
  try {
    const pem = await fs.readFile(connectCrt, 'utf8');
    if (cfg.tls_acme_account_key_sealed) {
      const accountKey = await loadOrCreateAccountKey(cfg);
      const client = new acme.Client({
        directoryUrl: directoryUrlFor(cfg.tls_acme_environment ?? 'staging'),
        accountKey,
      });
      await client.revokeCertificate(pem).catch((err) => {
        logger.warn('tls.revoke_failed', {
          msg: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch {
    // No cert on disk — nothing to revoke. Fall through to delete metadata.
  }
  for (const name of ['connect.crt', 'connect.key', 'portal.crt', 'portal.key']) {
    await fs.rm(path.join(env.tlsOutputDir, name), { force: true });
  }
  await db('firm_settings').where({ id: 1 }).update({
    tls_cert_subject: null,
    tls_cert_issuer: null,
    tls_cert_expires_at: null,
    tls_cert_requested_at: null,
    tls_last_error: null,
  });
  await auditRepo.write({
    actorUserId: actorUserId ?? undefined,
    action: 'admin.tls_revoked',
    targetType: 'firm_settings',
  });
}

// --------------- Ticker ---------------

let tickerHandle: NodeJS.Timeout | null = null;
const TICKER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 5 * 60 * 1000;

export function startTlsRenewalTicker(): void {
  if (tickerHandle) return;
  const tick = async (): Promise<void> => {
    try {
      const result = await renewIfExpiring({ actorUserId: null });
      if (result.renewed) {
        logger.info('tls.auto_renewed');
      }
    } catch (err) {
      logger.error('tls.auto_renew_failed', {
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };
  setTimeout(() => {
    void tick();
    tickerHandle = setInterval(() => void tick(), TICKER_INTERVAL_MS);
  }, BOOT_DELAY_MS);
}

export function stopTlsRenewalTicker(): void {
  if (tickerHandle) {
    clearInterval(tickerHandle);
    tickerHandle = null;
  }
}
