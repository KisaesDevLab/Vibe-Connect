import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PasswordStrengthBar } from '../components/PasswordStrengthBar.js';
import { useAuth } from '../state/auth.js';
import { useCrypto } from '../state/crypto.js';

export function EnrollmentPage(): JSX.Element {
  const { user } = useAuth();
  const { hasDevice, enroll, unlock } = useCrypto();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (hasDevice) {
        const ok = await unlock(password);
        if (!ok) {
          setError('Incorrect password for this device.');
          return;
        }
      } else {
        await enroll(password);
      }
      nav('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-slate-50 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md bg-white shadow-card rounded-xl p-8 space-y-4"
      >
        <h1 className="text-lg font-semibold text-slate-900">
          {hasDevice ? 'Unlock this device' : 'Enroll this device'}
        </h1>
        <p className="text-sm text-slate-600">
          {hasDevice
            ? `Enter your password to unlock your saved keys on this device, ${user?.displayName}.`
            : `This is the first time you've signed in on this device. Enter your password again so we can set up end-to-end encrypted messaging.`}
        </p>
        <label className="block">
          <span className="text-sm text-slate-700">
            {hasDevice ? 'Device passphrase' : 'New device passphrase (min 12 chars)'}
          </span>
          <input
            type="password"
            autoComplete={hasDevice ? 'current-password' : 'new-password'}
            required
            minLength={hasDevice ? undefined : 12}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {!hasDevice && <PasswordStrengthBar password={password} />}
        </label>
        {error && <div className="text-sm text-rose-600">{error}</div>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-brand-600 text-white font-medium py-2 hover:bg-brand-700 disabled:opacity-60"
        >
          {busy ? (hasDevice ? 'Unlocking…' : 'Enrolling…') : hasDevice ? 'Unlock' : 'Enroll'}
        </button>
      </form>
    </div>
  );
}
