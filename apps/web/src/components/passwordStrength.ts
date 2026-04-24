// Password-strength scoring for enrollment / change / install screens.
// Intentionally lightweight — no zxcvbn dependency. CLAUDE.md sets a 12-char
// minimum; this extends with a breadth-of-character-class bonus, a repeat-run
// penalty, and a tiny blocklist of the worst offenders that still pass length.
//
// Returns a score in [0, 4]:
//   0 — unusable (typically <12 chars or a common phrase)
//   1 — weak
//   2 — fair
//   3 — strong
//   4 — very strong

const COMMON_LOW_ENTROPY = new Set([
  'password',
  'passwordpassword',
  'letmeinletmein',
  'changemechangeme',
  'qwertyuiopqwerty',
  'abcdefghabcdefgh',
  'adminadminadmin',
  'vibeconnectvibe',
  '123456789012',
  '111111111111',
  'passw0rdpassw0',
  'correcthorsebattery', // the xkcd one — too well known
]);

export interface PasswordStrengthResult {
  score: 0 | 1 | 2 | 3 | 4;
  label: 'too short' | 'weak' | 'fair' | 'strong' | 'very strong';
  warnings: string[];
}

export function scorePassword(pw: string): PasswordStrengthResult {
  const warnings: string[] = [];
  if (pw.length < 12) {
    return { score: 0, label: 'too short', warnings: ['Use at least 12 characters.'] };
  }
  const lower = /[a-z]/.test(pw);
  const upper = /[A-Z]/.test(pw);
  const digit = /[0-9]/.test(pw);
  const symbol = /[^A-Za-z0-9]/.test(pw);
  const classes = [lower, upper, digit, symbol].filter(Boolean).length;
  let points = 0;
  if (pw.length >= 12) points += 1;
  if (pw.length >= 16) points += 1;
  if (pw.length >= 20) points += 1;
  if (pw.length >= 28) points += 1;
  if (classes >= 2) points += 1;
  if (classes >= 3) points += 1;
  if (classes >= 4) points += 1;
  // Entropy proxy — a password with lots of unique characters is harder to brute-force.
  const uniqueFraction = new Set(pw).size / pw.length;
  if (uniqueFraction < 0.4) {
    points -= 2;
    warnings.push('Too many repeated characters.');
  } else if (uniqueFraction < 0.55) {
    points -= 1;
  }
  // Run-of-three penalty (aaa / 123 / abc).
  if (
    /(.)\1{2,}/.test(pw) ||
    /(?:012|123|234|345|456|567|678|789|890|abc|bcd|cde|def)/i.test(pw)
  ) {
    points -= 1;
    warnings.push('Avoid obvious runs like "123" or "aaa".');
  }
  // Blocklist.
  if (COMMON_LOW_ENTROPY.has(pw.toLowerCase())) {
    return {
      score: 0,
      label: 'too short',
      warnings: ['This is a commonly used passphrase. Pick something else.'],
    };
  }
  const score: 0 | 1 | 2 | 3 | 4 = Math.max(0, Math.min(4, points)) as 0 | 1 | 2 | 3 | 4;
  const label: PasswordStrengthResult['label'] =
    score === 0 ? 'weak' : score === 1 ? 'weak' : score === 2 ? 'fair' : score === 3 ? 'strong' : 'very strong';
  if (classes < 3) warnings.push('Mix more character types (upper, lower, digits, symbols).');
  return { score, label, warnings };
}
