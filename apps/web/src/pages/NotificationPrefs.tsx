import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { useAuth } from '../state/auth.js';
import { url as appUrl } from '../lib/boot.js';
import { enablePush, useDesktopNotifications } from '../state/notifications.js';

interface Prefs {
  user_id: string;
  dnd_enabled: boolean;
  dnd_start: string;
  dnd_end: string;
  timezone: string;
  urgent_overrides_dnd: boolean;
  email_fallback_enabled: boolean;
  email_fallback_urgent_only: number;
  sms_fallback_enabled: boolean;
  sms_fallback_urgent_only: number;
}

// MUST route through `appUrl()` so the BASE_PATH prefix is applied. On
// the multi-app appliance the staff app lives at /connect/ and the
// upstream Caddy strip_prefix only fires for /connect/*; a raw fetch
// to `/notifications/prefs` falls into the apex catch-all → console
// 404. The other staff fetches use api.ts's helper which already
// applies appUrl; this page predates that and was its own fetch
// wrapper, so we add the prefix here.
async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(appUrl(path), {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as T;
}

export function NotificationPrefsPage(): JSX.Element {
  const qc = useQueryClient();
  const { user, refresh } = useAuth();
  const { permission, requestPermission } = useDesktopNotifications();
  const q = useQuery({
    queryKey: ['notification-prefs'],
    queryFn: () => json<{ prefs: Prefs }>('/notifications/prefs').then((r) => r.prefs),
  });
  const policyQ = useQuery({
    queryKey: ['security-policy'],
    queryFn: () => api.getSecurityPolicy(),
    staleTime: 60_000,
  });
  const mut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      json('/notifications/prefs', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-prefs'] }),
  });

  if (!q.data)
    return (
      <div className="h-full overflow-y-auto">
        <div className="p-6 text-sm text-slate-500">Loading…</div>
      </div>
    );
  const p = q.data;
  const smsAvailableAtFirm = policyQ.data?.smsAvailable !== false; // default to true while loading
  const hasPhone = Boolean(user?.phone);
  // Toggling SMS on requires both a phone on file AND a firm-level provider —
  // otherwise the preference is meaningless. We let the user clear an enabled
  // pref even when those preconditions are gone (so disconnecting a provider
  // doesn't strand the toggle), but block enabling.
  const canEnableSms = smsAvailableAtFirm && hasPhone;
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-lg p-6 space-y-4 pb-8">
        <h2 className="font-semibold text-slate-900 text-lg">Notifications</h2>

        <div className="bg-white rounded shadow-card p-4 space-y-2">
          <h3 className="font-medium text-slate-800">Desktop</h3>
          <p className="text-sm text-slate-600">
            Current browser permission: <strong>{permission}</strong>
          </p>
          {permission !== 'granted' && (
            <button
              type="button"
              className="rounded-md bg-brand-600 text-white text-sm px-3 py-1.5 hover:bg-brand-700"
              onClick={() => void requestPermission()}
            >
              Enable
            </button>
          )}
        </div>

        <div className="bg-white rounded shadow-card p-4 space-y-2">
          <h3 className="font-medium text-slate-800">Mobile / Push</h3>
          <p className="text-sm text-slate-600">
            Push notifications never include message content — only a &quot;you have a new
            message&quot; prompt.
          </p>
          <button
            type="button"
            className="rounded-md bg-brand-600 text-white text-sm px-3 py-1.5 hover:bg-brand-700"
            onClick={() =>
              enablePush().then((ok) => alert(ok ? 'Enabled' : 'Failed — check browser support'))
            }
          >
            Enable push
          </button>
        </div>

        <div className="bg-white rounded shadow-card p-4 space-y-3">
          <h3 className="font-medium text-slate-800">Do Not Disturb</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              defaultChecked={p.dnd_enabled}
              onChange={(e) => mut.mutate({ dndEnabled: e.target.checked })}
            />
            Enable DND
          </label>
          <div className="flex gap-3 items-center text-sm">
            <label>
              Start:
              <input
                type="time"
                defaultValue={p.dnd_start}
                onBlur={(e) => mut.mutate({ dndStart: e.target.value })}
                className="ml-2 rounded border border-slate-300 px-2 py-1"
              />
            </label>
            <label>
              End:
              <input
                type="time"
                defaultValue={p.dnd_end}
                onBlur={(e) => mut.mutate({ dndEnd: e.target.value })}
                className="ml-2 rounded border border-slate-300 px-2 py-1"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              defaultChecked={p.urgent_overrides_dnd}
              onChange={(e) => mut.mutate({ urgentOverridesDnd: e.target.checked })}
            />
            Urgent messages still ring during DND
          </label>
        </div>

        <div className="bg-white rounded shadow-card p-4 space-y-2">
          <h3 className="font-medium text-slate-800">Email fallback</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              defaultChecked={p.email_fallback_enabled}
              onChange={(e) => mut.mutate({ emailFallbackEnabled: e.target.checked })}
            />
            Email me when I&apos;m offline
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              defaultChecked={Boolean(p.email_fallback_urgent_only)}
              onChange={(e) => mut.mutate({ emailFallbackUrgentOnly: e.target.checked })}
            />
            Only for urgent messages
          </label>
          <p className="text-xs text-slate-500">
            Emails intentionally never include message content — just a &quot;you have a new
            message&quot; link.
            {!user?.email && (
              <span className="block mt-1 text-amber-700">
                No email on file — your admin sets this on your user account.
              </span>
            )}
          </p>
        </div>

        <PhoneCard phone={user?.phone ?? null} onSaved={() => refresh()} />

        <div className="bg-white rounded shadow-card p-4 space-y-2">
          <h3 className="font-medium text-slate-800">SMS fallback</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={p.sms_fallback_enabled}
              disabled={!canEnableSms && !p.sms_fallback_enabled}
              onChange={(e) => mut.mutate({ smsFallbackEnabled: e.target.checked })}
            />
            Text me when I&apos;m offline
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              defaultChecked={Boolean(p.sms_fallback_urgent_only)}
              disabled={!p.sms_fallback_enabled}
              onChange={(e) => mut.mutate({ smsFallbackUrgentOnly: e.target.checked })}
            />
            Only for urgent messages
          </label>
          <p className="text-xs text-slate-500">Texts are metadata-only — same rule as email.</p>
          {!hasPhone && (
            <p className="text-xs text-amber-700">
              Add a mobile number above before enabling SMS notifications.
            </p>
          )}
          {hasPhone && !smsAvailableAtFirm && (
            <p className="text-xs text-amber-700">
              Your firm&apos;s SMS provider isn&apos;t configured. Ask an admin to set one up in{' '}
              <strong>Admin → Text messages</strong>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// E.164 normaliser. Mirrors apps/server/src/services/accessCodes.ts
// normalizePhone() so the input the user types here matches what the server
// will accept on PATCH /auth/me. Returns null when the input can't be coerced
// into a plausible international number, letting the UI block save instead of
// shipping garbage to the server.
function normalizePhoneInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return null;
    return `+${digits}`;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  return null;
}

function PhoneCard({
  phone,
  onSaved,
}: {
  phone: string | null;
  onSaved: () => void | Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState<string>(phone ?? '');
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const dirty = draft.trim() !== (phone ?? '');
  const save = useMutation({
    mutationFn: (value: string | null) => api.updateMe({ phone: value }),
    onSuccess: () => {
      setError(null);
      setSavedAt(Date.now());
      void onSaved();
    },
    onError: (e: Error) => {
      setError(e.message.includes('400') ? 'That phone number isn’t valid.' : e.message);
    },
  });
  function onSave(): void {
    setError(null);
    const trimmed = draft.trim();
    if (!trimmed) {
      save.mutate(null);
      return;
    }
    const normalized = normalizePhoneInput(trimmed);
    if (!normalized) {
      setError('Enter a valid phone number — country code recommended.');
      return;
    }
    save.mutate(normalized);
  }
  return (
    <div className="bg-white rounded shadow-card p-4 space-y-2">
      <h3 className="font-medium text-slate-800">My mobile number</h3>
      <p className="text-xs text-slate-500">
        Used only for the SMS fallback below — never for delivering message content. Stored in E.164
        form (e.g. <code className="text-[11px]">+15551234567</code>).
      </p>
      <div className="flex items-center gap-2">
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+1 555 123 4567"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || save.isPending}
          className="rounded-md bg-brand-600 text-white text-sm px-3 py-1.5 hover:bg-brand-700 disabled:bg-slate-300"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {phone && !dirty && (
          <button
            type="button"
            onClick={() => {
              setDraft('');
              save.mutate(null);
            }}
            className="text-xs text-slate-500 hover:text-rose-700"
          >
            Remove
          </button>
        )}
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
      {savedAt && !error && !dirty && <p className="text-xs text-emerald-700">Saved.</p>}
    </div>
  );
}
