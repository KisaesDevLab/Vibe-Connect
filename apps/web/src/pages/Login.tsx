import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../state/auth.js';

export function LoginPage(): JSX.Element {
  const { login } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [oidcLoginUrl, setOidcLoginUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .oidcConfig()
      .then((c) => {
        if (!cancelled && c.enabled && c.loginUrl) setOidcLoginUrl(c.loginUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
      nav('/');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes('401') ? 'Wrong username or password' : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-slate-50 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-white shadow-card rounded-xl p-8 space-y-4"
      >
        <div className="text-center mb-2">
          <div className="mx-auto w-12 h-12 rounded-lg bg-brand-600 text-white grid place-items-center font-bold text-xl">
            VC
          </div>
          <h1 className="mt-3 text-lg font-semibold text-slate-900">Vibe Connect</h1>
          <p className="text-sm text-slate-500">Sign in with your staff account</p>
        </div>

        <label className="block">
          <span className="text-sm text-slate-700">Username</span>
          <input
            type="text"
            autoComplete="username"
            required
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label className="block">
          <span className="text-sm text-slate-700">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <div className="text-sm text-rose-600">{error}</div>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-brand-600 text-white font-medium py-2 hover:bg-brand-700 disabled:opacity-60"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {oidcLoginUrl && (
          <>
            <div className="relative flex items-center my-2 text-xs text-slate-400">
              <span className="flex-grow h-px bg-slate-200" />
              <span className="px-2 uppercase tracking-wide">or</span>
              <span className="flex-grow h-px bg-slate-200" />
            </div>
            <a
              href={oidcLoginUrl}
              className="block text-center w-full rounded-md border border-slate-300 text-slate-700 font-medium py-2 hover:bg-slate-50"
            >
              Sign in with SSO
            </a>
          </>
        )}
      </form>
    </div>
  );
}
