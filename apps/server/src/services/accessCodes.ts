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

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) return null;
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

export async function verifyAccessCode(
  identity: Identity,
  code: string,
): Promise<{ ok: boolean; reason?: 'expired' | 'used' | 'mismatch' | 'locked' }> {
  const row = await db('access_codes')
    .where({ external_identity_id: identity.id })
    .whereNull('used_at')
    .where('expires_at', '>=', db.fn.now())
    .orderBy('created_at', 'desc')
    .first();
  if (!row) return { ok: false, reason: 'expired' };
  if (row.attempts >= 5) return { ok: false, reason: 'locked' };
  const ok = await bcrypt.compare(code, row.code_hash);
  await db('access_codes')
    .where({ id: row.id })
    .update({ attempts: row.attempts + 1 });
  if (!ok) return { ok: false, reason: 'mismatch' };
  await db('access_codes').where({ id: row.id }).update({ used_at: db.fn.now() });
  await auditRepo.write({
    actorExternalIdentityId: identity.id,
    action: 'portal.code_verified',
    targetType: 'external_identity',
    targetId: identity.id,
  });
  return { ok: true };
}

export function hashSessionToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}
