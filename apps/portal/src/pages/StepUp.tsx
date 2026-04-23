import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { portalApi } from '../api.js';

export function StepUpPage(): JSX.Element {
  const [last4, setLast4] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await portalApi.stepup(last4);
      nav('/messages');
    } catch (err) {
      const e = err as { status?: number; body?: string };
      setError(e.status === 401 ? "Those 4 digits don't match. Please try again." : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-white shadow rounded-xl p-8 space-y-4"
      >
        <h1 className="text-lg font-semibold">Verify your identity</h1>
        <p className="text-sm text-slate-600">
          Please enter the last 4 digits of your SSN or EIN that your firm has on file.
        </p>
        <input
          inputMode="numeric"
          pattern="\d{4}"
          maxLength={4}
          required
          className="w-full text-center tracking-[0.5em] text-xl rounded-md border border-slate-300 py-3 focus:border-brand-500 focus:outline-none"
          value={last4}
          onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
        {error && <div className="text-sm text-rose-600">{error}</div>}
        <button
          type="submit"
          disabled={busy || last4.length !== 4}
          className="w-full rounded-md bg-brand-600 text-white font-medium py-2 hover:bg-brand-700 disabled:opacity-60"
        >
          {busy ? 'Verifying…' : 'Verify'}
        </button>
      </form>
    </div>
  );
}
