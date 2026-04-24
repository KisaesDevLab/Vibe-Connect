// Client portal access codes — 6-digit, single-use, bcrypt-stored, rate-limited.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db } from '../db/knex.js';
import { auditRepo } from '../repositories/audit.js';

export interface Identity {
  id: string;
  email: string;
  phone: string | null;
  display_name: string;
  verification_type: 'ssn' | 'ein' | 'none';
  verification_last4_hash: string | null;
  verification_required: boolean;
  deactivated_at: string | null;
}

export function generateSixDigitCode(): string {
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

export async function findIdentityByIdentifier(identifier: string): Promise<Identity | null> {
  const e = identifier.trim().toLowerCase();
  // Email match first
  const byEmail = await db<Identity>('external_identities').where({ email: e }).first();
  if (byEmail) return byEmail;
  const phone = normalizePhone(identifier);
  if (!phone) return null;
  const byPhone = await db<Identity>('external_identities').where({ phone }).first();
  return byPhone ?? null;
}

/**
 * Canonicalise a phone number to E.164-ish form so identifiy lookups match
 * whatever shape was stored at admin-invite time.
 *
 * Rules (deliberately simple — no libphonenumber dependency):
 *   - Strip everything that isn't a digit or leading '+'.
 *   - 10 digits exactly (no country code) → NANP default, prepend '1'.
 *   - 11 digits starting with '1'         → already NANP-with-country-code.
 *   - >=11 digits not starting with '1'   → international; keep as-is.
 *   - <10 digits                          → too short to be a real phone, return null.
 *
 * Always emits a leading '+'. Callers storing inbound identities should
 * normalise before insert; callers looking up inbound SMS should normalise the
 * provider's `from` the same way (Twilio already sends `+1...`, but defensive
 * consistency is cheap).
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 10) return null;
  if (!hasPlus && digits.length === 10) return '+1' + digits;
  if (!hasPlus && digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return '+' + digits;
}

export async function issueAccessCode(
  identity: Identity,
  via: 'email' | 'sms',
): Promise<{ id: string; code: string; sentTo: string }> {
  // Rate limit: at most 3 non-expired codes per identity in 10 minutes.
  const recent = await db('access_codes')
    .where({ external_identity_id: identity.id })
    .where('created_at', '>', db.raw(`NOW() - INTERVAL '10 minutes'`))
    .count<{ count: string }[]>('* as count');
  if (Number(recent[0]!.count) >= 3) {
    throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' });
  }
  const code = generateSixDigitCode();
  const hash = await bcrypt.hash(code, 10);
  const sentTo = via === 'email' ? identity.email : (identity.phone ?? identity.email);
  const [row] = await db('access_codes')
    .insert({
      external_identity_id: identity.id,
      code_hash: hash,
      sent_to: sentTo,
      sent_via: via,
      expires_at: db.raw(`NOW() + INTERVAL '10 minutes'`),
    })
    .returning(['id']);
  await auditRepo.write({
    actorExternalIdentityId: identity.id,
    action: 'portal.code_issued',
    targetType: 'external_identity',
    targetId: identity.id,
    details: { via },
  });
  return { id: row!.id, code, sentTo };
}

// A precomputed bcrypt hash of a value no real 6-digit code can equal ("x").
// Used to equalise timing when there is no row, the code is expired, or the
// lockout has tripped — so an attacker can't distinguish "locked" (no bcrypt
// work) from "wrong code" (bcrypt compare) by wall-clock.
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('x', 10);

export async function verifyAccessCode(
  identity: Identity,
  code: string,
): Promise<{ ok: boolean; reason?: 'expired' | 'used' | 'mismatch' | 'locked' }> {
  // Whole attempt is serialized per code row via SELECT ... FOR UPDATE so two
  // parallel POSTs cannot (a) both read attempts<5 and bypass the lockout, or
  // (b) both mark used_at and double-consume the same code. bcrypt runs inside
  // the tx by design — it rate-limits concurrent guessing to one-per-CPU-slot.
  return db.transaction(async (trx) => {
    const row = await trx('access_codes')
      .where({ external_identity_id: identity.id })
      .whereNull('used_at')
      .where('expires_at', '>=', trx.fn.now())
      .orderBy('created_at', 'desc')
      .forUpdate()
      .first();
    if (!row) {
      await bcrypt.compare(code, DUMMY_BCRYPT_HASH);
      return { ok: false, reason: 'expired' as const };
    }
    if (row.attempts >= 5) {
      await bcrypt.compare(code, DUMMY_BCRYPT_HASH);
      return { ok: false, reason: 'locked' as const };
    }
    const ok = await bcrypt.compare(code, row.code_hash);
    if (!ok) {
      await trx('access_codes')
        .where({ id: row.id })
        .update({ attempts: row.attempts + 1 });
      return { ok: false, reason: 'mismatch' as const };
    }
    await trx('access_codes')
      .where({ id: row.id })
      .update({ attempts: row.attempts + 1, used_at: trx.fn.now() });
    await auditRepo.write({
      actorExternalIdentityId: identity.id,
      action: 'portal.code_verified',
      targetType: 'external_identity',
      targetId: identity.id,
    });
    return { ok: true };
  });
}

export function hashSessionToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// -------- Per-identity brute-force lockouts --------
//
// The per-code (5 attempts) and per-IP (3 issuances per 10 min) limits stop
// single-attacker-single-IP brute force. They do not stop a distributed
// attacker rotating IPs: each IP can trigger fresh codes and burn its 5
// attempts before the per-code lockout fires. The helpers below look across
// the attacker-controlled axes (IPs, sessions) and cap total bad activity
// per identity over a rolling window.

const VERIFY_ATTEMPTS_PER_IDENTITY_PER_HOUR = 30;
const STEPUP_LOCKOUTS_PER_IDENTITY_PER_DAY = 5;

/**
 * Return the sum of `attempts` across every code issued to this identity in
 * the last hour — i.e., how many wrong-code tries this identity has cost us
 * cumulatively. Used to refuse fresh /verify calls once the identity has
 * absorbed too much brute-force work, regardless of which IP is calling.
 */
export async function recentVerifyAttemptsForIdentity(identityId: string): Promise<number> {
  const rows = await db('access_codes')
    .where({ external_identity_id: identityId })
    .where('created_at', '>', db.raw(`NOW() - INTERVAL '1 hour'`))
    .select('attempts');
  return rows.reduce((sum, r) => sum + Number(r.attempts ?? 0), 0);
}

export function isVerifyLockedForIdentity(attempts: number): boolean {
  return attempts >= VERIFY_ATTEMPTS_PER_IDENTITY_PER_HOUR;
}

/**
 * Count how many sessions for this identity have been step-up-revoked in the
 * past 24 h. We read the audit log rather than adding a dedicated table — it
 * already records `portal.stepup_locked` for every lockout and is indexed on
 * actor_external_identity_id + created_at.
 */
export async function recentStepupLockoutsForIdentity(identityId: string): Promise<number> {
  const [row] = await db('audit_log')
    .where({
      actor_external_identity_id: identityId,
      action: 'portal.stepup_locked',
    })
    .where('created_at', '>', db.raw(`NOW() - INTERVAL '24 hours'`))
    .count<{ count: string }[]>('* as count');
  return Number(row?.count ?? 0);
}

export function isStepupLockedForIdentity(lockouts: number): boolean {
  return lockouts >= STEPUP_LOCKOUTS_PER_IDENTITY_PER_DAY;
}
