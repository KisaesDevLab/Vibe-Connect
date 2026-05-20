// E.164 normalisation for SMS recipient phone numbers.
//
// Mirrors apps/web/src/components/InviteClientModal.tsx#normalizeE164
// so a phone typed in any of the common North-American shapes ends up
// in strict `+<country><subscriber>` form before it hits a provider.
//
// Why server-side AND client-side: the staff invite modal normalises
// on submit and posts the canonical form, but other server-side entry
// points (Admin → Providers Test, the portal /identify retry, future
// API integrations) don't all go through that modal. Centralising the
// rule here means every outbound SMS goes through one place.

/**
 * Normalise a free-text phone string to E.164 (`+<country><digits>`).
 *
 * Accepts:
 *   - Already-E.164 (`+15551234567`) — pass through after stripping
 *     spaces / dashes / parens.
 *   - US 10-digit (`5551234567` / `(555) 123-4567`) → prefixes with
 *     the supplied `defaultCountryCode` (default `+1`).
 *   - US 11-digit starting with `1` (`15551234567` / `1-555-123-4567`)
 *     → prefixes with `+` (does NOT double-prefix `+1`).
 *   - Any digit string 7–15 chars long without a recognised US shape
 *     → prefixes with `+` and assumes the operator typed an
 *     international number without `+`.
 *
 * Returns `null` if the input is empty, contains non-digit characters
 * after stripping, or the resulting digit count is outside the E.164
 * 7–15 range. Callers should surface this as a validation error.
 */
export function normalizeE164(raw: string, defaultCountryCode = '+1'): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return null;
    return `+${digits}`;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) return null;
  // US 10-digit: prepend the configured default country (`+1`).
  if (digits.length === 10) {
    return `${defaultCountryCode}${digits}`;
  }
  // US 11-digit beginning with 1: already has the country code, just
  // needs the `+`.
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  // Catch-all for international numbers typed without a `+`. Range
  // check matches the E.164 spec (7–15 subscriber digits).
  if (digits.length >= 7 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}
