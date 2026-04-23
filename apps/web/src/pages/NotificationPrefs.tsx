import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as T;
}

export function NotificationPrefsPage(): JSX.Element {
  const qc = useQueryClient();
  const { permission, requestPermission } = useDesktopNotifications();
  const q = useQuery({
    queryKey: ['notification-prefs'],
    queryFn: () => json<{ prefs: Prefs }>('/notifications/prefs').then((r) => r.prefs),
  });
  const mut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      json('/notifications/prefs', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-prefs'] }),
  });

  if (!q.data) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  const p = q.data;
  return (
    <div className="max-w-lg p-6 space-y-4">
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
        </p>
      </div>
    </div>
  );
}
