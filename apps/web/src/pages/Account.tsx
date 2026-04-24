// Self-service account page: change password, set avatar, view your own enrolled
// devices. All endpoints are already server-implemented; this just wires UI.
import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { PasswordStrengthBar } from '../components/PasswordStrengthBar.js';
import { useAuth } from '../state/auth.js';

/** Small relative-time helper. Keeps the device table readable without
 *  pulling in date-fns for one column. Falls back to the user's locale
 *  formatter for anything older than a week. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  if (Number.isNaN(diffMs)) return iso;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(then).toLocaleDateString();
}

export function AccountPage(): JSX.Element {
  const { user, refresh } = useAuth();
  const qc = useQueryClient();
  return (
    <div className="p-4 max-w-2xl space-y-6">
      <div>
        <h2 className="font-semibold text-slate-900">Account</h2>
        <p className="text-sm text-slate-600">
          Signed in as <strong>{user?.displayName}</strong>{' '}
          <span className="text-slate-400">(@{user?.username})</span>
        </p>
      </div>
      <AvatarCard
        onUploaded={() => {
          void refresh();
          void qc.invalidateQueries({ queryKey: ['users'] });
        }}
      />
      <ChangePasswordCard />
      <MyDevicesCard />
    </div>
  );
}

function AvatarCard({ onUploaded }: { onUploaded: () => void }): JSX.Element {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: (f: File) => api.uploadAvatar(f),
    onSuccess: () => onUploaded(),
    onError: (e: Error) => setError(e.message),
  });
  return (
    <section className="bg-white rounded shadow-card p-4 space-y-3">
      <h3 className="font-medium text-slate-900">Avatar</h3>
      <p className="text-xs text-slate-500">
        PNG, JPG, WebP, or GIF, up to 5 MB. Stored encrypted at rest on the appliance.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            setError(null);
            mut.mutate(f);
            e.target.value = '';
          }
        }}
        className="text-sm"
      />
      {mut.isPending && <div className="text-xs text-slate-500">Uploading…</div>}
      {mut.isSuccess && <div className="text-xs text-emerald-700">Avatar updated.</div>}
      {error && <div className="text-xs text-rose-600">{error}</div>}
    </section>
  );
}

function ChangePasswordCard(): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const mut = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setDone(true);
      setCurrent('');
      setNext('');
      setNext2('');
    },
    onError: (e: Error) => setError(e.message.includes('400') ? 'Wrong current password.' : e.message),
  });
  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== next2) return setError('New passwords do not match.');
    if (next.length < 12) return setError('New password must be at least 12 characters.');
    if (next === current) return setError('New password must differ from current.');
    mut.mutate();
  }
  return (
    <section className="bg-white rounded shadow-card p-4 space-y-3">
      <h3 className="font-medium text-slate-900">Change password</h3>
      <p className="text-xs text-slate-500">
        Changing your password does not re-wrap your device keys. Your device passphrase
        (set at enrollment) is separate.
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block">
          <span className="text-sm text-slate-700">Current password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="input"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm text-slate-700">New password</span>
            <input
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className="input"
            />
            <PasswordStrengthBar password={next} />
          </label>
          <label className="block">
            <span className="text-sm text-slate-700">Confirm new password</span>
            <input
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              value={next2}
              onChange={(e) => setNext2(e.target.value)}
              className="input"
            />
          </label>
        </div>
        {error && <div className="text-sm text-rose-600">{error}</div>}
        {done && <div className="text-sm text-emerald-700">Password changed.</div>}
        <button type="submit" disabled={mut.isPending} className="btn-primary">
          {mut.isPending ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </section>
  );
}

function MyDevicesCard(): JSX.Element {
  const q = useQuery({
    queryKey: ['me', 'devices'],
    queryFn: () => api.listMyDevices(),
    staleTime: 30_000,
  });
  return (
    <section className="bg-white rounded shadow-card p-4 space-y-3">
      <h3 className="font-medium text-slate-900">My enrolled devices</h3>
      <p className="text-xs text-slate-500">
        Each row is a browser or app that holds a wrapped copy of your encryption key.
        Contact your firm admin to revoke a lost device.
      </p>
      {q.isLoading ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200">
              <th className="p-2">Device ID</th>
              <th className="p-2">Platform</th>
              <th className="p-2">Version</th>
              <th className="p-2">Last seen</th>
              <th className="p-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.devices ?? []).map((d) => (
              <tr key={d.id} className="border-b border-slate-100">
                <td className="p-2 font-mono text-[10px]">{d.deviceId}</td>
                <td className="p-2">{d.clientPlatform}</td>
                <td className="p-2">{d.clientVersion ?? '—'}</td>
                <td
                  className="p-2"
                  title={d.lastHeartbeatAt ? new Date(d.lastHeartbeatAt).toLocaleString() : undefined}
                >
                  {d.lastHeartbeatAt ? relativeTime(d.lastHeartbeatAt) : '—'}
                </td>
                <td className="p-2">{d.revokedAt ? 'revoked' : `v${d.keyVersion}`}</td>
              </tr>
            ))}
            {(q.data?.devices ?? []).length === 0 && (
              <tr>
                <td className="p-2 text-slate-500" colSpan={5}>
                  No devices enrolled yet. Sign in from another browser or the desktop
                  app to enroll; each enrollment adds a wrapped copy of your key here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
