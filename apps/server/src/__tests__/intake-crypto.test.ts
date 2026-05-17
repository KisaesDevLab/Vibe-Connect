/**
 * intakeCrypto round-trip + invariants (Phase 28.1 acceptance criterion:
 * "Encrypted columns are bytea and round-trip cleanly through the helper").
 *
 * We mutate process.env.CONNECT_INTAKE_ENCRYPTION_KEY BEFORE the first
 * import so env.ts captures the key during module init; this mirrors the
 * `clamav.test.ts` pattern. The `__resetIntakeCryptoCache` export lets us
 * flip keys mid-suite to test rotation-style invariants without spawning
 * a fresh vitest fork.
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

beforeAll(() => {
  process.env.CONNECT_INTAKE_ENCRYPTION_KEY = KEY_A;
});

describe('intakeCrypto', () => {
  it('round-trips a UTF-8 field through encryptField/decryptField', async () => {
    const { encryptField, decryptField } = await import('../services/intakeCrypto.js');
    const plain = 'Maria — María — 日本語 — العربية';
    const ct = await encryptField(plain);
    expect(Buffer.isBuffer(ct)).toBe(true);
    // secretbox: 24-byte nonce + ciphertext + 16-byte tag ≥ 40 bytes for any plaintext.
    expect(ct.length).toBeGreaterThanOrEqual(plain.length + 24 + 16);
    expect(await decryptField(ct)).toBe(plain);
  });

  it('produces a fresh nonce on every call (CCA-safe)', async () => {
    const { encryptField } = await import('../services/intakeCrypto.js');
    const a = await encryptField('same plaintext');
    const b = await encryptField('same plaintext');
    expect(a.equals(b)).toBe(false);
  });

  it('decryptField rejects tampered ciphertext', async () => {
    const { encryptField, decryptField } = await import('../services/intakeCrypto.js');
    const ct = await encryptField('integrity check');
    const tampered = Buffer.from(ct);
    // Flip a byte deep in the ciphertext (past the 24-byte nonce header).
    tampered[30] = (tampered[30] ?? 0) ^ 0x01;
    await expect(decryptField(tampered)).rejects.toThrow();
  });

  it('hashForAudit is deterministic for a given key + plaintext', async () => {
    const { hashForAudit } = await import('../services/intakeCrypto.js');
    const a = hashForAudit('client@example.com');
    const b = hashForAudit('client@example.com');
    expect(a).toBe(b);
    expect(hashForAudit('different@example.com')).not.toBe(a);
  });

  it('searchHash is deterministic and independent of the intake content key', async () => {
    const mod = await import('../services/intakeCrypto.js');
    const before = mod.searchHash('client@example.com');
    // Rotate the intake content key. searchHash must remain stable because
    // it is HKDF-derived from SESSION_SECRET, not from the intake key.
    process.env.CONNECT_INTAKE_ENCRYPTION_KEY = KEY_B;
    mod.__resetIntakeCryptoCache();
    const after = mod.searchHash('client@example.com');
    expect(after).toBe(before);
    // Restore key A so subsequent tests in this file keep encrypting under
    // the same key they decrypt with.
    process.env.CONNECT_INTAKE_ENCRYPTION_KEY = KEY_A;
    mod.__resetIntakeCryptoCache();
  });

  it('hashForAudit and searchHash use different keys (cross-collision-free)', async () => {
    const { hashForAudit, searchHash } = await import('../services/intakeCrypto.js');
    const input = 'compare-me@example.com';
    expect(hashForAudit(input)).not.toBe(searchHash(input));
  });

  it('searchHashEquals is constant-time and handles mismatched lengths', async () => {
    const { searchHash, searchHashEquals } = await import('../services/intakeCrypto.js');
    const h = searchHash('whatever');
    expect(searchHashEquals(h, h)).toBe(true);
    expect(searchHashEquals(h, h + 'A')).toBe(false);
    expect(searchHashEquals(h, 'different')).toBe(false);
  });

  // Sentinel exists + is exported. Behavior coverage (hashForAudit returning
  // it when the key is unset) is verified end-to-end at the route layer —
  // exercising it as a unit test would require mocking the env module that
  // intakeCrypto.ts captures at import time. The sentinel value itself is
  // stable + asserted here so a future rename surfaces as a test failure.
  it('exports HASH_FOR_AUDIT_UNKEYED sentinel for audit viewers to recognize', async () => {
    const mod = await import('../services/intakeCrypto.js');
    expect(mod.HASH_FOR_AUDIT_UNKEYED).toBe('unkeyed-no-intake-key');
  });
});
