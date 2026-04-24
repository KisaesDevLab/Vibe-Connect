// First-boot install wizard. Shown only when GET /install/status returns
// {installed:false}. Submits POST /install/install and displays the 24-word
// firm recovery phrase exactly once — per CLAUDE.md this is the only place the
// user ever sees it in plaintext.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { PasswordStrengthBar } from '../components/PasswordStrengthBar.js';
import { useAuth } from '../state/auth.js';

interface InstallResult {
  recoveryPhrase: string[];
  firmPublicKey: string;
}

export function InstallPage(): JSX.Element {
  const nav = useNavigate();
  const { login } = useAuth();
  const [firmName, setFirmName] = useState('');
  const [adminUsername, setAdminUsername] = useState('');
  const [adminDisplayName, setAdminDisplayName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminPassword2, setAdminPassword2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [createdCreds, setCreatedCreds] = useState<{ username: string; password: string } | null>(null);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (adminPassword !== adminPassword2) {
      setError('Passwords do not match.');
      return;
    }
    if (adminPassword.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.install({
        firmName,
        adminUsername,
        adminDisplayName,
        adminEmail: adminEmail || undefined,
        adminPassword,
      });
      setResult({ recoveryPhrase: r.recoveryPhrase, firmPublicKey: r.firmPublicKey });
      setCreatedCreds({ username: adminUsername, password: adminPassword });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function continueToApp(): Promise<void> {
    if (createdCreds) {
      try {
        await login(createdCreds.username, createdCreds.password);
        nav('/enrollment');
        return;
      } catch {
        /* fall back to login page if auto-login fails */
      }
    }
    nav('/login');
  }

  if (result) {
    return (
      <RecoveryPhraseStep
        result={result}
        confirmed={confirmed}
        onConfirm={() => {
          // CRYPTO: once the user checks "I've saved the phrase", wipe it
          // from React state so it isn't accessible via DevTools / React
          // Devtools from this point on. We keep firmPublicKey (non-secret)
          // so the continue handler still has context. The user can't
          // un-check and get the phrase back; that's intentional — if they
          // didn't save it, they must re-install.
          setResult({ recoveryPhrase: [], firmPublicKey: result.firmPublicKey });
          setConfirmed(true);
        }}
        onContinue={() => void continueToApp()}
      />
    );
  }

  return (
    <div className="min-h-screen grid place-items-center bg-slate-50 px-4 py-12">
      <form onSubmit={onSubmit} className="w-full max-w-lg bg-white shadow-card rounded-xl p-8 space-y-4">
        <div className="mb-2">
          <div className="mx-auto w-12 h-12 rounded-lg bg-brand-600 text-white grid place-items-center font-bold text-xl">VC</div>
          <h1 className="mt-3 text-center text-lg font-semibold text-slate-900">Set up Vibe Connect</h1>
          <p className="text-sm text-center text-slate-500">
            Create the firm crypto key and your first administrator. You will see the
            24-word recovery phrase exactly once.
          </p>
        </div>

        <label className="block">
          <span className="text-sm text-slate-700">Firm name</span>
          <input
            type="text"
            required
            maxLength={255}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
            value={firmName}
            onChange={(e) => setFirmName(e.target.value)}
          />
        </label>

        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-slate-700">Admin username</span>
            <input
              type="text"
              required
              minLength={2}
              maxLength={64}
              pattern="[A-Za-z0-9_.\-]+"
              autoComplete="username"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
              value={adminUsername}
              onChange={(e) => setAdminUsername(e.target.value)}
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-700">Display name</span>
            <input
              type="text"
              required
              maxLength={128}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
              value={adminDisplayName}
              onChange={(e) => setAdminDisplayName(e.target.value)}
            />
          </label>
        </div>

        <label className="block">
          <span className="text-sm text-slate-700">
            Email <span className="text-slate-400">(optional)</span>
          </span>
          <input
            type="email"
            maxLength={254}
            autoComplete="email"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
          />
        </label>

        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-slate-700">Password</span>
            <input
              type="password"
              required
              minLength={12}
              maxLength={512}
              autoComplete="new-password"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
            />
            <PasswordStrengthBar password={adminPassword} />
          </label>

          <label className="block">
            <span className="text-sm text-slate-700">Confirm password</span>
            <input
              type="password"
              required
              minLength={12}
              maxLength={512}
              autoComplete="new-password"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
              value={adminPassword2}
              onChange={(e) => setAdminPassword2(e.target.value)}
            />
          </label>
        </div>

        <p className="text-xs text-slate-500">Passwords must be at least 12 characters.</p>

        {error && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">{error}</div>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-brand-600 text-white font-medium py-2 hover:bg-brand-700 disabled:opacity-60"
        >
          {busy ? 'Creating firm key…' : 'Create firm and continue'}
        </button>
      </form>
    </div>
  );
}

function RecoveryPhraseStep({
  result,
  confirmed,
  onConfirm,
  onContinue,
}: {
  result: InstallResult;
  confirmed: boolean;
  onConfirm: () => void;
  onContinue: () => void;
}): JSX.Element {
  const words = result.recoveryPhrase;
  const phraseText = words.join(' ');
  // CRYPTO: copy/clear state machine. 'copied' shows confirmation; 'cleared'
  // tells the user the OS paste buffer has been overwritten so they don't
  // think the phrase is still there for a second paste; 'failed' surfaces
  // secure-context / permission errors instead of swallowing them.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'cleared' | 'failed'>('idle');

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(phraseText);
      setCopyState('copied');
      // Overwrite the OS paste buffer after ~30s so the recovery phrase does
      // not linger in clipboard history. Best-effort: if the user copied
      // something else in between, writeText replaces whatever is current.
      // We can't guarantee cross-browser clipboard-history wipe — but we can
      // at least avoid leaving our own plaintext at the top of the stack.
      window.setTimeout(() => {
        void navigator.clipboard
          .writeText('')
          .then(() => setCopyState('cleared'))
          .catch(() => {
            /* clipboard may have been reclaimed by another app; no-op */
          });
      }, 30_000);
    } catch {
      // Non-secure contexts (http://) or denied permission land here. Tell
      // the user so they can select-and-copy manually rather than guessing
      // the button silently worked.
      setCopyState('failed');
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-2xl bg-white shadow-card rounded-xl p-8 space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Firm recovery phrase</h1>
          <p className="mt-2 text-sm text-slate-600">
            Write these 24 words down <em>now</em> and store them somewhere physically secure.
            This phrase is the only way to recover firm-wide conversations if an admin loses
            their device, and to rotate the firm key. It will never be shown again and is not
            stored on the server.
          </p>
          <p className="mt-2 text-sm text-rose-700 font-semibold">
            Losing this phrase means permanently losing the ability to decrypt all conversations
            if the last enrolled device is wiped.
          </p>
        </div>

        {words.length > 0 ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
            <ol className="grid grid-cols-3 sm:grid-cols-4 gap-2 list-decimal list-inside text-sm font-mono">
              {words.map((w, i) => (
                <li key={i} className="text-slate-800">
                  {w}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900">
            Recovery phrase confirmed and cleared from this page. Keep your written
            copy somewhere safe — it will never be shown again.
          </div>
        )}

        {words.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={copy}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
            >
              {copyState === 'copied'
                ? 'Copied ✓'
                : copyState === 'cleared'
                  ? 'Clipboard cleared'
                  : copyState === 'failed'
                    ? 'Copy failed — select & copy manually'
                    : 'Copy to clipboard'}
            </button>
            <span className="text-xs text-slate-500">
              {copyState === 'copied'
                ? 'Clipboard will auto-clear in 30 seconds.'
                : copyState === 'cleared'
                  ? 'Clipboard contents replaced. Your written copy is what matters.'
                  : copyState === 'failed'
                    ? 'Your browser blocked clipboard access. Select the words above and copy manually.'
                    : 'Copying to clipboard is convenient, but a written copy is what matters.'}
            </span>
          </div>
        )}

        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={confirmed}
            onChange={(e) => (e.target.checked ? onConfirm() : null)}
            className="mt-1"
          />
          <span>
            I have saved the 24-word recovery phrase in a place I control. I understand that
            Vibe Connect cannot recover it for me.
          </span>
        </label>

        <button
          type="button"
          disabled={!confirmed}
          onClick={onContinue}
          className="w-full rounded-md bg-brand-600 text-white font-medium py-2 hover:bg-brand-700 disabled:opacity-60"
        >
          Continue to sign-in
        </button>
      </div>
    </div>
  );
}
