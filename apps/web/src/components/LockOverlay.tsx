// Full-screen modal shown when the device is idle-locked. Requires the enrollment
// passphrase to restore the in-memory device secret key.
import { useState, type FormEvent } from 'react';
import { useAuth } from '../state/auth.js';
import { useCrypto } from '../state/crypto.js';

export function LockOverlay(): JSX.Element | null {
  const { isLocked, unlock, idleLockMs } = useCrypto();
  const { user, logout } = useAuth();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isLocked) return null;

  // Format the idle threshold back into a friendly unit. idleLockMs is
  // either 0 (never — which means we got here via manual lock) or a
  // positive integer number of minutes. Admins pick values like 5/15/60;
  // keep the copy fluent across common picks.
  const idleMinutes = Math.round(idleLockMs / 60_000);
  const thresholdCopy =
    idleLockMs <= 0
      ? 'Session locked by request.'
      : idleMinutes >= 60
        ? `Idle for ${Math.round(idleMinutes / 60)} hour${idleMinutes >= 120 ? 's' : ''}.`
        : `Idle for ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'}.`;

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ok = await unlock(password);
      if (!ok) setError('Wrong passphrase.');
      else setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-50 grid place-items-center p-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-white dark:bg-slate-800 rounded-xl shadow-xl p-6 space-y-3"
      >
        <div className="text-center">
          <div className="mx-auto w-12 h-12 rounded-lg bg-amber-100 text-amber-700 grid place-items-center text-2xl">
            🔒
          </div>
          <h2 className="mt-3 font-semibold text-slate-900">Session locked</h2>
          <p className="text-sm text-slate-500 mt-1">
            {thresholdCopy} Enter your device passphrase to continue.
          </p>
        </div>
        {user && (
          <div className="text-xs text-center text-slate-500">
            Signed in as <strong>{user.displayName}</strong>
          </div>
        )}
        <input
          type="password"
          autoFocus
          required
          minLength={12}
          placeholder="Device passphrase"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input"
        />
        {error && <div className="text-sm text-rose-600 text-center">{error}</div>}
        <button type="submit" disabled={busy} className="w-full btn-primary">
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        <button
          type="button"
          onClick={() => void logout()}
          className="w-full text-xs text-slate-500 hover:text-slate-800 pt-1"
        >
          Or sign out
        </button>
      </form>
    </div>
  );
}
