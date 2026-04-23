/**
 * Regression: the email unsubscribe link must be HMAC-signed so an attacker cannot enumerate
 * external_identity UUIDs and mass-unsubscribe users. The prior implementation accepted a
 * raw UUID as the ?t= value.
 */
import { describe, expect, it, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-unsubscribe-secret';
});

describe('unsubscribe tokens', () => {
  it('signs a token that verifies for the same identity', async () => {
    const { signUnsubscribeToken, verifyUnsubscribeToken } =
      await import('../bridges/unsubscribeTokens.js');
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    const token = signUnsubscribeToken(id);
    expect(verifyUnsubscribeToken(token)).toBe(id);
  });

  it('rejects tampering with the payload', async () => {
    const { signUnsubscribeToken, verifyUnsubscribeToken } =
      await import('../bridges/unsubscribeTokens.js');
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    const token = signUnsubscribeToken(id);
    const [encoded, sig] = token.split('.');
    // Swap the payload to a different UUID but keep the original signature.
    const forged = Buffer.from('u1|ffffffff-ffff-ffff-ffff-ffffffffffff').toString('base64url');
    expect(verifyUnsubscribeToken(`${forged}.${sig}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${encoded}.invalidsig`)).toBeNull();
  });

  it('rejects a raw UUID (regression for the pre-fix behavior)', async () => {
    const { verifyUnsubscribeToken } = await import('../bridges/unsubscribeTokens.js');
    expect(verifyUnsubscribeToken('01234567-89ab-cdef-0123-456789abcdef')).toBeNull();
  });
});
