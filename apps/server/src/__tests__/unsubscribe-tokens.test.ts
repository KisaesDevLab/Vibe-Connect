/**
 * Regression + hardening: the email unsubscribe link must be signed so an
 * attacker cannot enumerate external_identity UUIDs and mass-unsubscribe
 * users. The pre-HMAC implementation accepted a raw UUID. The current
 * implementation encrypts the payload (u2) so the UUID isn't readable from
 * the URL either; u1 HMAC tokens remain supported for outstanding emails.
 */
import { describe, expect, it, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-unsubscribe-secret';
});

describe('unsubscribe tokens', () => {
  it('u2: signs a token that verifies for the same identity', async () => {
    const { signUnsubscribeToken, verifyUnsubscribeToken } =
      await import('../bridges/unsubscribeTokens.js');
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    const token = await signUnsubscribeToken(id);
    expect(token.startsWith('u2.')).toBe(true);
    expect(await verifyUnsubscribeToken(token)).toBe(id);
  });

  it('u2: identity UUID is not readable from the token text', async () => {
    // The whole point of the u2 switch: the UUID must not appear in the
    // encoded token. A passive attacker with the URL shouldn't learn who
    // the recipient is.
    const { signUnsubscribeToken } = await import('../bridges/unsubscribeTokens.js');
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    const token = await signUnsubscribeToken(id);
    expect(token).not.toContain(id);
    // Also the base64url-decoded payload bytes must not contain the raw
    // UUID string — secretbox produces ciphertext, not cleartext.
    const decoded = Buffer.from(token.slice(3), 'base64url').toString('binary');
    expect(decoded).not.toContain(id);
  });

  it('u2: rejects tampering with the ciphertext', async () => {
    const { signUnsubscribeToken, verifyUnsubscribeToken } =
      await import('../bridges/unsubscribeTokens.js');
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    const token = await signUnsubscribeToken(id);
    const body = Buffer.from(token.slice(3), 'base64url');
    // Flip a single bit in the last byte — secretbox's Poly1305 tag must
    // reject. Bracket-notation with a nullish-coalesce keeps strict-null TS
    // happy when --noUncheckedIndexedAccess is on.
    const lastIdx = body.length - 1;
    body[lastIdx] = (body[lastIdx] ?? 0) ^ 0x01;
    const tampered = `u2.${body.toString('base64url')}`;
    expect(await verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it('u1 (legacy): verifies existing HMAC-signed tokens', async () => {
    // Outstanding emails already delivered before the u2 switch carry u1
    // tokens. Verification must keep accepting them.
    const { signUnsubscribeTokenLegacy, verifyUnsubscribeToken } =
      await import('../bridges/unsubscribeTokens.js');
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    const legacy = signUnsubscribeTokenLegacy(id);
    expect(await verifyUnsubscribeToken(legacy)).toBe(id);
  });

  it('rejects a raw UUID (regression for the pre-HMAC behaviour)', async () => {
    const { verifyUnsubscribeToken } = await import('../bridges/unsubscribeTokens.js');
    expect(await verifyUnsubscribeToken('01234567-89ab-cdef-0123-456789abcdef')).toBeNull();
  });
});
