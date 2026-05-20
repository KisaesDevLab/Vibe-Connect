/**
 * Unit tests for the shared E.164 phone normaliser.
 *
 * Used by the Admin → Providers Test SMS endpoint (and any future
 * server-side entry point that needs to accept free-text phone input
 * before handing it to a provider). Mirrors the rule the staff invite
 * modal applies client-side.
 */
import { describe, expect, it } from 'vitest';
import { normalizeE164 } from '../services/phoneFormat.js';

describe('normalizeE164', () => {
  it('passes E.164 input through after stripping formatting', () => {
    expect(normalizeE164('+15551234567')).toBe('+15551234567');
    expect(normalizeE164('+1 (555) 123-4567')).toBe('+15551234567');
    expect(normalizeE164('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('prefixes US 10-digit input with +1', () => {
    expect(normalizeE164('5551234567')).toBe('+15551234567');
    expect(normalizeE164('(555) 123-4567')).toBe('+15551234567');
    expect(normalizeE164('555-123-4567')).toBe('+15551234567');
    // Regression for the user-reported case: a real US number that the
    // old endpoint turned into `+4175554645` (no country has code 4).
    expect(normalizeE164('4175554645')).toBe('+14175554645');
    expect(normalizeE164('(417) 555-4645')).toBe('+14175554645');
  });

  it('handles US 11-digit input starting with 1 by adding `+` only', () => {
    expect(normalizeE164('15551234567')).toBe('+15551234567');
    expect(normalizeE164('1-555-123-4567')).toBe('+15551234567');
  });

  it('honours a non-default countryCode parameter for 10-digit input', () => {
    // CA shares +1 by default, but UK appliances might want +44.
    expect(normalizeE164('5551234567', '+44')).toBe('+445551234567');
  });

  it('falls back to prepending `+` for other lengths (international without +)', () => {
    // 12 digits with no leading 1 — caller probably typed an
    // international number without the +. Accept it.
    expect(normalizeE164('441234567890')).toBe('+441234567890');
  });

  it('returns null for empty / non-string / unparseable input', () => {
    expect(normalizeE164('')).toBeNull();
    expect(normalizeE164('   ')).toBeNull();
    expect(normalizeE164('abc')).toBeNull();
    expect(normalizeE164('+')).toBeNull();
    // 6 digits — below E.164 minimum.
    expect(normalizeE164('123456')).toBeNull();
    // 16 digits — above E.164 maximum.
    expect(normalizeE164('1234567890123456')).toBeNull();
    expect(normalizeE164(null as unknown as string)).toBeNull();
  });
});
