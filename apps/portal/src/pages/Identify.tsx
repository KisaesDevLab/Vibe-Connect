import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { portalApi } from '../api.js';

export function IdentifyPage(): JSX.Element {
  const [identifier, setIdentifier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await portalApi.identify(identifier);
      sessionStorage.setItem('identifier', identifier);
      nav('/verify');
    } catch {
      // Never leak whether the identifier matched — keep the same success message.
      sessionStorage.setItem('identifier', identifier);
      nav('/verify');
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
        <div className="text-center">
          <div className="mx-auto w-12 h-12 rounded-lg bg-brand-600 text-white grid place-items-center font-bold">
            VC
          </div>
          <h1 className="mt-3 text-lg font-semibold">Firm Portal</h1>
          <p className="text-sm text-slate-500">
            Enter the email or phone number your firm has on file.
          </p>
        </div>
        <label className="block">
          <span className="text-sm text-slate-700">Email or phone</span>
          <input
            type="text"
            autoComplete="email"
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
          />
        </label>
        {error && <div className="text-sm text-rose-600">{error}</div>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-brand-600 text-white font-medium py-2 hover:bg-brand-700 disabled:opacity-60"
        >
          {busy ? 'Sending…' : 'Send access code'}
        </button>
      </form>
    </div>
  );
}
