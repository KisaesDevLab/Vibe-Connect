// Admin-writable provider credentials (Twilio, TextLink, Postmark, SMTP).
//
// Security model
// --------------
// - KEK: HKDF-SHA256(SESSION_SECRET, salt='vibe-connect/provider-secrets/v1',
//   length=32). Derived once at process start; held in memory only. Rotating
//   SESSION_SECRET invalidates all stored credentials — operators must
//   re-enter them. This is a deliberate trade-off over introducing a second
//   env secret the operator has to manage.
// - Cipher: libsodium secretbox (XSalsa20-Poly1305) via @vibe-connect/crypto.
//   Nonce is bundled into the sealed blob by the shared helper — we don't
//   roll our own framing.
// - Writes: audit-logged with action='admin.provider_secret_updated'. Value
//   never appears in the audit row (only the registry key + last-4 + a
//   SHA-256 fingerprint to distinguish rotations of the same secret).
// - Reads: no admin HTTP endpoint returns the plaintext — the bridges pull
//   it in-process via get(); callers that log errors must scrub the return.
//
// This module is the ONLY path that touches sealed_value. Every other caller
// goes through get / set / clear / metaList so the crypto invariants stay
// in one place.
import { createHash } from 'node:crypto';
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import { auditRepo } from '../repositories/audit.js';
import { sealString, unsealString } from './kekSeal.js';

// Registry of every credential the app knows how to store. The UI renders
// rows for these in order; unknown keys are rejected at write time so typos
// can't create shadow records that never get read by any bridge.
export const PROVIDER_SECRET_KEYS = [
  // --- SMS — TextLink ---
  'sms.textlink.api_key',
  'sms.textlink.webhook_secret',
  // --- SMS — Twilio ---
  'sms.twilio.account_sid',
  'sms.twilio.auth_token',
  'sms.twilio.from_number',
  'sms.twilio.messaging_service_sid',
  // --- Email — Postmark ---
  'email.postmark.server_token',
  'email.postmark.inbound_webhook_secret',
  // --- Email — SMTP (Postfix-compatible) ---
  'email.smtp.host',
  'email.smtp.port',
  'email.smtp.user',
  'email.smtp.pass',
  'email.smtp.secure',
] as const;
export type ProviderSecretKey = (typeof PROVIDER_SECRET_KEYS)[number];
const KEY_SET: ReadonlySet<string> = new Set(PROVIDER_SECRET_KEYS);

export function isKnownKey(key: string): key is ProviderSecretKey {
  return KEY_SET.has(key);
}

// Keys where we DON'T compute a last4 because the value is meant to be shown
// (SMTP host, port, `secure` flag). Secrets (tokens, passwords) always mask.
const NON_SECRET_KEYS: ReadonlySet<ProviderSecretKey> = new Set([
  'email.smtp.host',
  'email.smtp.port',
  'email.smtp.secure',
]);
export function isMaskedKey(key: ProviderSecretKey): boolean {
  return !NON_SECRET_KEYS.has(key);
}

// Crypto lives in services/kekSeal.ts so the same KEK powers both this
// module and services/tlsAcme.ts without either owning the invariant alone.

// --------------- Public API ---------------

export interface ProviderSecretMeta {
  key: ProviderSecretKey;
  configured: boolean;
  last4: string | null;
  updatedAt: string | null;
  updatedByUserId: string | null;
  masked: boolean;
}

/** Fetch the plaintext value. Null when unset. Callers MUST NOT log this. */
export async function get(key: ProviderSecretKey): Promise<string | null> {
  if (!isKnownKey(key)) return null;
  const row = await db('firm_provider_credentials').where({ key }).first();
  if (!row) return null;
  try {
    return await unsealString(row.sealed_value as string);
  } catch (err) {
    // Most common cause: SESSION_SECRET rotated after the value was written.
    // Log the failure but NOT the ciphertext or key material.
    logger.error('provider_secret_decrypt_failed', {
      key,
      msg: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Fetch the plaintext from DB first, falling back to a cleartext env var.
 * The env path preserves backwards compatibility for installs that haven't
 * migrated their .env yet — logs a deprecation warning once per process.
 */
const envFallbackWarned = new Set<string>();
export async function getOrEnvFallback(
  key: ProviderSecretKey,
  envValue: string | null | undefined,
): Promise<string | null> {
  const stored = await get(key);
  if (stored) return stored;
  if (envValue && envValue.length > 0) {
    if (!envFallbackWarned.has(key)) {
      envFallbackWarned.add(key);
      logger.warn('provider_secret_env_fallback', {
        key,
        advice: 'Move this value into Admin → Providers; env fallback is for compatibility only.',
      });
    }
    return envValue;
  }
  return null;
}

/** Compute a UI-friendly "last-4" marker. Null for non-secret keys (host,
 *  port, flags) so the UI treats them as "show the full value" rather than
 *  masked. */
function computeLast4(key: ProviderSecretKey, value: string): string | null {
  if (!isMaskedKey(key)) return null;
  const trimmed = value.trim();
  if (trimmed.length < 4) return null;
  return trimmed.slice(-4);
}

export async function set(
  key: ProviderSecretKey,
  value: string,
  actorUserId: string | null,
): Promise<ProviderSecretMeta> {
  if (!isKnownKey(key)) throw new Error(`unknown_provider_secret_key: ${key}`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error('provider_secret_empty');
  const sealed = await sealString(trimmed);
  const last4 = computeLast4(key, trimmed);
  await db('firm_provider_credentials')
    .insert({
      key,
      sealed_value: sealed,
      last4,
      updated_at: db.fn.now(),
      updated_by_user_id: actorUserId,
    })
    .onConflict('key')
    .merge({
      sealed_value: sealed,
      last4,
      updated_at: db.fn.now(),
      updated_by_user_id: actorUserId,
    });
  // Audit: record a SHA-256 fingerprint of the VALUE so two rotations with
  // the same string can be distinguished without revealing the value itself.
  const fingerprint = createHash('sha256').update(trimmed).digest('base64');
  await auditRepo.write({
    actorUserId: actorUserId ?? undefined,
    action: 'admin.provider_secret_updated',
    targetType: 'firm_provider_credential',
    targetId: key,
    details: { last4, fingerprint, masked: isMaskedKey(key) },
  });
  const meta = await metaForKey(key);
  if (!meta) throw new Error('provider_secret_write_roundtrip_failed');
  return meta;
}

export async function clear(key: ProviderSecretKey, actorUserId: string | null): Promise<void> {
  if (!isKnownKey(key)) throw new Error(`unknown_provider_secret_key: ${key}`);
  const removed = await db('firm_provider_credentials').where({ key }).del();
  if (removed > 0) {
    await auditRepo.write({
      actorUserId: actorUserId ?? undefined,
      action: 'admin.provider_secret_cleared',
      targetType: 'firm_provider_credential',
      targetId: key,
    });
  }
}

/** Full list with one row per registry key, filled in with DB metadata when
 *  configured. Never returns plaintext values. */
export async function metaList(): Promise<ProviderSecretMeta[]> {
  const rows = await db('firm_provider_credentials').select(
    'key',
    'last4',
    'updated_at as updatedAt',
    'updated_by_user_id as updatedByUserId',
  );
  const byKey = new Map(rows.map((r) => [r.key as string, r]));
  return PROVIDER_SECRET_KEYS.map((key) => {
    const row = byKey.get(key);
    return {
      key,
      configured: Boolean(row),
      last4: (row?.last4 as string | null | undefined) ?? null,
      updatedAt: row?.updatedAt ? new Date(row.updatedAt as Date).toISOString() : null,
      updatedByUserId: (row?.updatedByUserId as string | null | undefined) ?? null,
      masked: isMaskedKey(key),
    };
  });
}

async function metaForKey(key: ProviderSecretKey): Promise<ProviderSecretMeta | null> {
  const list = await metaList();
  return list.find((m) => m.key === key) ?? null;
}
