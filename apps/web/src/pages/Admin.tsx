import { useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../api.js';

const tabs = [
  { path: 'users', label: 'Users' },
  { path: 'groups', label: 'Groups' },
  { path: 'settings', label: 'Settings' },
  { path: 'audit', label: 'Audit log' },
  { path: 'devices', label: 'Device health' },
];

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as T;
}

export function AdminPage(): JSX.Element {
  const loc = useLocation();
  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-slate-200 bg-white px-4">
        <nav className="flex gap-2">
          {tabs.map((t) => (
            <NavLink
              key={t.path}
              to={`/admin/${t.path}`}
              className={({ isActive }) =>
                clsx(
                  'px-3 py-3 text-sm',
                  isActive || loc.pathname.endsWith(t.path)
                    ? 'border-b-2 border-brand-600 text-brand-800 font-medium'
                    : 'text-slate-600 hover:text-slate-900',
                )
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="flex-1 overflow-y-auto">
        <DeviceDriftBanner />
        <Routes>
          <Route path="users" element={<AdminUsers />} />
          <Route path="groups" element={<AdminGroups />} />
          <Route path="settings" element={<AdminSettings />} />
          <Route path="audit" element={<AdminAudit />} />
          <Route path="devices" element={<AdminDevices />} />
          <Route index element={<AdminUsers />} />
        </Routes>
      </div>
    </div>
  );
}

function DeviceDriftBanner(): JSX.Element | null {
  const q = useQuery({
    queryKey: ['admin', 'devices'],
    queryFn: () => json<{ devices: Array<{ flag: string; createdAt: string }> }>(`/admin/devices`),
  });
  const [dismissed, setDismissed] = useState(false);
  const drifted = (q.data?.devices ?? []).filter((d) => d.flag === 'update_drift');
  if (dismissed || drifted.length === 0) return null;
  return (
    <div className="bg-amber-50 border-b border-amber-200 text-amber-900 text-sm px-4 py-2 flex justify-between">
      <span>
        <strong>{drifted.length}</strong> device{drifted.length === 1 ? ' is' : 's are'} running an
        older version for more than 14 days.
      </span>
      <div className="flex items-center gap-3">
        <NavLink to="/admin/devices" className="underline">
          Review
        </NavLink>
        <button
          type="button"
          className="text-amber-800 hover:text-amber-950"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function AdminUsers(): JSX.Element {
  const q = useQuery({ queryKey: ['users'], queryFn: () => api.listUsers() });
  return (
    <div className="p-4">
      <h2 className="font-semibold text-slate-900 mb-3">Users</h2>
      <table className="w-full text-sm bg-white rounded shadow-card">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="p-2">Name</th>
            <th className="p-2">Username</th>
            <th className="p-2">Email</th>
            <th className="p-2">Admin</th>
            <th className="p-2">Active</th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.users ?? []).map((u) => (
            <tr key={u.id} className="border-b border-slate-100">
              <td className="p-2">{u.displayName}</td>
              <td className="p-2">@{u.username}</td>
              <td className="p-2 text-slate-600">{u.email ?? '—'}</td>
              <td className="p-2">{u.isAdmin ? '✔' : ''}</td>
              <td className="p-2">{u.isActive ? '✔' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-slate-500 mt-2">
        Use <code>POST /admin/users/bulk</code> for CSV imports; inline create form lands in a later
        iteration.
      </p>
    </div>
  );
}

function AdminGroups(): JSX.Element {
  const q = useQuery({ queryKey: ['groups'], queryFn: () => api.listGroups() });
  return (
    <div className="p-4">
      <h2 className="font-semibold text-slate-900 mb-3">Groups</h2>
      <ul className="bg-white rounded shadow-card divide-y divide-slate-100">
        {(q.data?.groups ?? []).map((g) => (
          <li key={g.id} className="p-3 flex items-center justify-between">
            <span>
              <strong>{g.name}</strong>
              <span className="ml-2 text-xs text-slate-500">{g.members.length} members</span>
            </span>
            <span className="text-xs text-slate-400">sort: {g.sortOrder}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AdminSettings(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () =>
      json<{ settings: Record<string, unknown> }>(`/admin/settings`).then((r) => r.settings),
  });
  const mut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      json(`/admin/settings`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'settings'] }),
  });
  if (q.isLoading || !q.data) return <div className="p-4 text-sm text-slate-500">Loading…</div>;
  const s = q.data as {
    firm_name: string;
    retention_days: number | null;
    stepup_timeout_hours: number;
    email_outbound_mode: 'summary' | 'content';
    sms_provider: 'textlink' | 'twilio' | 'mock';
  };
  return (
    <div className="p-4 max-w-lg space-y-4">
      <h2 className="font-semibold text-slate-900">Firm settings</h2>
      <label className="block">
        <span className="text-sm text-slate-700">Firm name</span>
        <input
          type="text"
          defaultValue={s.firm_name}
          onBlur={(e) => mut.mutate({ firmName: e.target.value })}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="text-sm text-slate-700">Retention (days, blank = keep forever)</span>
        <input
          type="number"
          defaultValue={s.retention_days ?? ''}
          onBlur={(e) =>
            mut.mutate({ retentionDays: e.target.value === '' ? null : Number(e.target.value) })
          }
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="text-sm text-slate-700">Step-up verification timeout</span>
        <select
          defaultValue={s.stepup_timeout_hours}
          onChange={(e) => mut.mutate({ stepupTimeoutHours: Number(e.target.value) })}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          <option value={4}>4 hours</option>
          <option value={8}>8 hours</option>
          <option value={24}>24 hours</option>
          <option value={168}>7 days</option>
          <option value={-1}>Never (require every session)</option>
        </select>
      </label>
      <label className="block">
        <span className="text-sm text-slate-700">Email outbound mode</span>
        <select
          defaultValue={s.email_outbound_mode}
          onChange={(e) => mut.mutate({ emailOutboundMode: e.target.value })}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="summary">Summary only (safer)</option>
          <option value="content">Include content preview</option>
        </select>
      </label>
      <label className="block">
        <span className="text-sm text-slate-700">SMS provider</span>
        <select
          defaultValue={s.sms_provider}
          onChange={(e) => mut.mutate({ smsProvider: e.target.value })}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="textlink">TextLink (BYOD phone)</option>
          <option value="twilio">Twilio (10DLC)</option>
          <option value="mock">Mock (dev only)</option>
        </select>
      </label>
    </div>
  );
}

function AdminAudit(): JSX.Element {
  const q = useQuery({
    queryKey: ['admin', 'audit'],
    queryFn: () =>
      json<{
        rows: Array<{
          id: string;
          action: string;
          targetType: string;
          targetId: string | null;
          createdAt: string;
          actorUserId: string | null;
        }>;
      }>(`/admin/audit`),
  });
  return (
    <div className="p-4">
      <h2 className="font-semibold text-slate-900 mb-3">Audit log</h2>
      <table className="w-full text-xs bg-white rounded shadow-card">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="p-2">Time</th>
            <th className="p-2">Action</th>
            <th className="p-2">Actor</th>
            <th className="p-2">Target</th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.rows ?? []).map((r) => (
            <tr key={r.id} className="border-b border-slate-100">
              <td className="p-2 whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td>
              <td className="p-2 font-mono">{r.action}</td>
              <td className="p-2 text-slate-600">{r.actorUserId?.slice(0, 8) ?? '—'}</td>
              <td className="p-2 text-slate-600">
                {r.targetType}
                {r.targetId ? ' · ' + r.targetId.slice(0, 8) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminDevices(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'devices'],
    queryFn: () =>
      json<{
        devices: Array<{
          id: string;
          username: string;
          displayName: string;
          deviceId: string;
          clientPlatform: string;
          clientVersion: string | null;
          lastHeartbeatAt: string | null;
          flag: string;
          flagExplanation: string;
          remediation: string;
          revokedAt: string | null;
        }>;
      }>(`/admin/devices`),
  });
  const revokeMut = useMutation({
    mutationFn: (id: string) => json(`/admin/devices/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'devices'] }),
  });
  return (
    <div className="p-4">
      <h2 className="font-semibold text-slate-900 mb-3">Device health</h2>
      <table className="w-full text-xs bg-white rounded shadow-card">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="p-2">User</th>
            <th className="p-2">Platform</th>
            <th className="p-2">Version</th>
            <th className="p-2">Last seen</th>
            <th className="p-2">Status</th>
            <th className="p-2">Action</th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.devices ?? []).map((d) => (
            <tr key={d.id} className="border-b border-slate-100">
              <td className="p-2">
                {d.displayName}
                <span className="ml-1 text-slate-400">@{d.username}</span>
              </td>
              <td className="p-2">{d.clientPlatform}</td>
              <td className="p-2">{d.clientVersion ?? '—'}</td>
              <td className="p-2">
                {d.lastHeartbeatAt ? new Date(d.lastHeartbeatAt).toLocaleString() : '—'}
              </td>
              <td className="p-2">
                <span
                  className={clsx(
                    'inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold',
                    d.flag === 'healthy' && 'bg-emerald-100 text-emerald-700',
                    d.flag === 'update_drift' && 'bg-amber-100 text-amber-800',
                    d.flag === 'stale' && 'bg-slate-200 text-slate-700',
                    d.flag === 'unknown_version' && 'bg-rose-100 text-rose-700',
                  )}
                >
                  {d.flag}
                </span>
                <div className="text-[11px] text-slate-500 mt-1">{d.flagExplanation}</div>
                {d.remediation && <div className="text-[11px] text-slate-400">{d.remediation}</div>}
              </td>
              <td className="p-2">
                {d.revokedAt ? (
                  <span className="text-slate-400">revoked</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm('Revoke this device?')) revokeMut.mutate(d.id);
                    }}
                    className="text-rose-600 hover:underline"
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
