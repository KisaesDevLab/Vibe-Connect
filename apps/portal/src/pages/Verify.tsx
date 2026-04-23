import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import * as crypto from '@vibe-connect/crypto';
import { portalApi } from '../api.js';

export function VerifyPage(): JSX.Element {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();
  const identifier = sessionStorage.getItem('identifier') ?? '';

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await crypto.ready();
      const kp = await crypto.generateKeypair();
      // Session keypair lives for the portal tab; stash in sessionStorage.
      sessionStorage.setItem('sessionPublicKey', kp.publicKey);
      sessionStorage.setItem('sessionSecretKey', kp.secretKey);
      const r = await portalApi.verify(identifier, code, kp.publicKey);
      if (r.verificationRequired) {
        nav('/stepup');
      } else {
        nav('/messages');
      }
    } catch (err) {
      const e = err as { status?: number; body?: string };
      setError(e.status === 401 ? 'Invalid or expired code.' : 'Something went wrong.');
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
        <h1 className="text-lg font-semibold text-center">Enter your access code</h1>
        <p className="text-sm text-slate-500 text-center">
          We sent a 6-digit code to {identifier || 'your contact on file'}.
        </p>
        <input
          inputMode="numeric"
          pattern="\d{6}"
          autoComplete="one-time-code"
          maxLength={6}
          className="w-full text-center tracking-[0.6em] text-2xl rounded-md border border-slate-300 py-3 focus:border-brand-500 focus:outline-none"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        {error && <div className="text-sm text-rose-600">{error}</div>}
        <button
          type="submit"
          disabled={busy || code.length !== 6}
          className="w-full rounded-md bg-brand-600 text-white font-medium py-2 hover:bg-brand-700 disabled:opacity-60"
        >
          {busy ? 'Verifying…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}
