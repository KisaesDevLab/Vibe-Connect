// Self-service account page: change password, set avatar, view your own enrolled
// devices. All endpoints are already server-implemented; this just wires UI.
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { PasswordStrengthBar } from '../components/PasswordStrengthBar.js';
import { url as appUrl } from '../lib/boot.js';
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
      <IntakeCardSettings />
      <ChangePasswordCard />
      <MyDevicesCard />
    </div>
  );
}

/**
 * Phase 28.2 — Staff self-service intake-card panel.
 *
 * One card alongside the other Account sections; no new tabs. Toggle =
 * opt-in to the public `/intake` page; bio/title/headshot drive what
 * walk-up clients see. Server enforces length caps (60 / 280) so the
 * counters here are advisory.
 */
function IntakeCardSettings(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me', 'intake-card'],
    queryFn: () => api.getMyIntakeCard(),
    staleTime: 30_000,
  });

  const patchMut = useMutation({
    mutationFn: (patch: {
      showOnIntakeCard?: boolean;
      bio?: string | null;
      title?: string | null;
      notifyMode?: 'realtime' | 'digest' | 'in_app_only';
    }) => api.patchMyIntakeCard(patch),
    onSuccess: (data) => {
      qc.setQueryData(['me', 'intake-card'], data);
    },
  });

  const headshotMut = useMutation({
    mutationFn: (file: File) => api.uploadIntakeCardHeadshot(file),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'intake-card'] });
    },
  });

  // Local form state — mirrors server values once loaded but lets the user
  // type without round-tripping every keystroke. Submit batches a PATCH.
  const [titleDraft, setTitleDraft] = useState<string>('');
  const [bioDraft, setBioDraft] = useState<string>('');
  // Sync drafts from server data once, after the first successful fetch.
  // The ref guards against clobbering in-progress edits when the query
  // refetches (e.g. after a headshot upload invalidates ['me','intake-card']).
  // useEffect (not state-during-render) avoids React's setState-during-
  // render warning + the corresponding infinite-re-render footgun if TQ
  // returns a fresh `data` reference on each refetch.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (q.data && !hydratedRef.current) {
      hydratedRef.current = true;
      setTitleDraft(q.data.title ?? '');
      setBioDraft(q.data.bio ?? '');
    }
  }, [q.data]);

  if (q.isLoading) {
    return (
      <section className="bg-white rounded shadow-card p-4 space-y-3">
        <h3 className="font-medium text-slate-900">Intake card</h3>
        <div className="text-sm text-slate-500">Loading…</div>
      </section>
    );
  }
  if (!q.data) {
    return (
      <section className="bg-white rounded shadow-card p-4 space-y-3">
        <h3 className="font-medium text-slate-900">Intake card</h3>
        <div className="text-sm text-rose-600">Could not load intake card settings.</div>
      </section>
    );
  }

  const TITLE_MAX = 60;
  const BIO_MAX = 280;
  const titleRemaining = TITLE_MAX - titleDraft.length;
  const bioRemaining = BIO_MAX - bioDraft.length;

  function onToggle(showOnIntakeCard: boolean): void {
    patchMut.mutate({ showOnIntakeCard });
  }

  function onSaveText(): void {
    patchMut.mutate({
      title: titleDraft.trim() === '' ? null : titleDraft.trim(),
      bio: bioDraft.trim() === '' ? null : bioDraft.trim(),
    });
  }

  function onHeadshotChange(e: ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0];
    if (!f) return;
    headshotMut.mutate(f);
    e.target.value = '';
  }

  const data = q.data;
  return (
    <section className="bg-white rounded shadow-card p-4 space-y-3">
      <h3 className="font-medium text-slate-900">Intake card</h3>
      <p className="text-xs text-slate-500">
        Your card appears on the public <code className="text-slate-700">/intake</code> page that
        walk-up clients see when they upload files. Toggle off to hide.
      </p>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={data.showOnIntakeCard}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={patchMut.isPending}
        />
        <span className="text-sm text-slate-700">Show me on the public intake page</span>
      </label>

      <div className="flex items-center gap-3">
        {data.headshotUrl ? (
          <img
            src={appUrl(data.headshotUrl)}
            alt="Your intake card headshot"
            className="w-20 h-20 rounded-full object-cover border border-slate-200"
          />
        ) : (
          <div className="w-20 h-20 rounded-full bg-slate-100 border border-slate-200 grid place-items-center text-slate-400 text-xs">
            No photo
          </div>
        )}
        <div className="flex-1 space-y-1">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={onHeadshotChange}
            disabled={headshotMut.isPending}
            className="text-sm"
          />
          <p className="text-xs text-slate-500">
            PNG, JPG, WebP, or GIF up to 5 MB. Resized to 400×400 WebP on the server.
          </p>
          {headshotMut.isPending && <div className="text-xs text-slate-500">Uploading…</div>}
          {headshotMut.isError && (
            <div className="text-xs text-rose-600">
              {(headshotMut.error as { status?: number } | null)?.status === 400
                ? 'That file isn’t a readable image.'
                : 'Upload failed.'}
            </div>
          )}
        </div>
      </div>

      <label className="block">
        <span className="text-sm text-slate-700">Title</span>
        <input
          type="text"
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value.slice(0, TITLE_MAX))}
          placeholder="e.g. Senior Tax Manager"
          className="input"
          disabled={patchMut.isPending}
        />
        <div
          className={`text-xs ${titleRemaining < 10 ? 'text-amber-600' : 'text-slate-400'}`}
          aria-live="polite"
        >
          {titleRemaining} characters left
        </div>
      </label>

      <label className="block">
        <span className="text-sm text-slate-700">Bio</span>
        <textarea
          value={bioDraft}
          onChange={(e) => setBioDraft(e.target.value.slice(0, BIO_MAX))}
          placeholder="A line or two clients see when they pick you on the intake page."
          rows={3}
          className="input"
          disabled={patchMut.isPending}
        />
        <div
          className={`text-xs ${bioRemaining < 20 ? 'text-amber-600' : 'text-slate-400'}`}
          aria-live="polite"
        >
          {bioRemaining} characters left
        </div>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn-primary"
          onClick={onSaveText}
          disabled={
            patchMut.isPending ||
            (titleDraft.trim() === (data.title ?? '') && bioDraft.trim() === (data.bio ?? ''))
          }
        >
          {patchMut.isPending ? 'Saving…' : 'Save title & bio'}
        </button>
        {patchMut.isSuccess && <span className="text-xs text-emerald-700">Saved.</span>}
        {patchMut.isError && (
          <span className="text-xs text-rose-600">Failed: {String(patchMut.error)}</span>
        )}
      </div>

      {/* Phase 28.12 (QA-followup) — notification preference. The in-app
          unread badge always updates regardless of this choice; it only
          controls the email channel. Admin-escalation emails (PDF
          conversion failures) always send immediately, bypassing both
          digest and in_app_only — they need attention now. */}
      <div className="border-t border-slate-100 pt-3 space-y-2">
        <div>
          <label htmlFor="intake-notify-mode" className="text-sm font-medium text-slate-700 block">
            Notify me about new intakes via email
          </label>
          <p className="text-xs text-slate-500">
            The in-app unread indicator always updates regardless of this setting.
          </p>
        </div>
        <select
          id="intake-notify-mode"
          value={data.notifyMode}
          onChange={(e) =>
            patchMut.mutate({
              notifyMode: e.target.value as 'realtime' | 'digest' | 'in_app_only',
            })
          }
          disabled={patchMut.isPending}
          className="input max-w-md"
        >
          <option value="realtime">For every intake (default)</option>
          <option value="digest">Once a day, in a digest at the firm&apos;s configured hour</option>
          <option value="in_app_only">Never email me — in-app only</option>
        </select>
      </div>
    </section>
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
    onError: (e: Error) =>
      setError(e.message.includes('400') ? 'Wrong current password.' : e.message),
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
        Changing your password does not re-wrap your device keys. Your device passphrase (set at
        enrollment) is separate.
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
        Each row is a browser or app that holds a wrapped copy of your encryption key. Contact your
        firm admin to revoke a lost device.
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
                  title={
                    d.lastHeartbeatAt ? new Date(d.lastHeartbeatAt).toLocaleString() : undefined
                  }
                >
                  {d.lastHeartbeatAt ? relativeTime(d.lastHeartbeatAt) : '—'}
                </td>
                <td className="p-2">{d.revokedAt ? 'revoked' : `v${d.keyVersion}`}</td>
              </tr>
            ))}
            {(q.data?.devices ?? []).length === 0 && (
              <tr>
                <td className="p-2 text-slate-500" colSpan={5}>
                  No devices enrolled yet. Sign in from another browser or the desktop app to
                  enroll; each enrollment adds a wrapped copy of your key here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
