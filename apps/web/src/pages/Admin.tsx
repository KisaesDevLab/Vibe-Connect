import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { splitRecoveryPhrase, combineRecoveryShares } from '@vibe-connect/crypto/shamir';
import { url as appUrl } from '../lib/boot.js';
import type { VaultFolderTemplate } from '@vibe-connect/shared-types';
import { api } from '../api.js';
import { InviteClientModal } from '../components/InviteClientModal.js';
import { PasswordStrengthBar } from '../components/PasswordStrengthBar.js';
import { useCrypto } from '../state/crypto.js';

const tabs = [
  { path: 'users', label: 'Users' },
  { path: 'groups', label: 'Groups' },
  { path: 'settings', label: 'Settings' },
  { path: 'providers', label: 'Providers' },
  { path: 'tls', label: 'TLS' },
  { path: 'audit', label: 'Audit log' },
  { path: 'devices', label: 'Device health' },
  { path: 'clients', label: 'Clients' },
  { path: 'client-sessions', label: 'Sessions' },
  { path: 'sms', label: 'SMS' },
  { path: 'export', label: 'Export' },
  { path: 'message-history', label: 'Message history' },
  { path: 'recovery', label: 'Recovery' },
  { path: 'request-templates', label: 'Templates', requiresRequests: true },
] as const;

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
  const policyQ = useQuery({
    queryKey: ['security-policy'],
    queryFn: () => api.getSecurityPolicy(),
    staleTime: 60_000,
  });
  const requestsEnabled = policyQ.data?.requestsEnabled !== false;
  const visibleTabs = tabs.filter((t) => !('requiresRequests' in t && t.requiresRequests) || requestsEnabled);
  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-slate-200 bg-white px-4">
        <nav className="flex gap-2">
          {visibleTabs.map((t) => (
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
          <Route path="providers" element={<AdminProviders />} />
          <Route path="tls" element={<AdminTls />} />
          <Route path="audit" element={<AdminAudit />} />
          <Route path="devices" element={<AdminDevices />} />
          <Route path="clients" element={<AdminClients />} />
          <Route path="client-sessions" element={<AdminClientSessions />} />
          <Route path="sms" element={<AdminSms />} />
          <Route path="export" element={<AdminExport />} />
          <Route path="message-history" element={<AdminMessageHistory />} />
          <Route path="recovery" element={<AdminRecovery />} />
          <Route path="request-templates" element={<AdminRequestTemplates />} />
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
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api.listUsers() });
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['users'] });
  };
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-900">Users</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="btn-ghost"
          >
            Import CSV
          </button>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="rounded-md bg-brand-600 text-white text-sm font-medium px-3 py-1.5 hover:bg-brand-700"
          >
            Add user
          </button>
        </div>
      </div>
      {q.isLoading && (
        <div className="text-xs text-slate-500 py-3">Loading users…</div>
      )}
      {q.error && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2 mb-2">
          Failed to load users: {(q.error as Error).message}
        </div>
      )}
      <table className="w-full text-sm bg-white rounded shadow-card">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="p-2">Name</th>
            <th className="p-2">Username</th>
            <th className="p-2">Email</th>
            <th className="p-2">Admin</th>
            <th className="p-2">Active</th>
            <th className="p-2"></th>
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
              <td className="p-2 text-right space-x-3 whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => setEditing(u.id)}
                  className="text-brand-700 hover:underline"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setResetting(u.id)}
                  className="text-slate-600 hover:underline"
                >
                  Reset password
                </button>
              </td>
            </tr>
          ))}
          {!q.isLoading && !q.error && (q.data?.users ?? []).length === 0 && (
            <tr>
              <td className="p-3 text-slate-500" colSpan={6}>
                No users yet. Click <strong>Add user</strong> above to invite one.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {addOpen && (
        <AddUserDialog
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            invalidate();
          }}
        />
      )}
      {importOpen && (
        <BulkImportDialog
          onClose={() => setImportOpen(false)}
          onDone={() => {
            invalidate();
          }}
        />
      )}
      {editing && (
        <EditUserDialog
          user={q.data!.users.find((u) => u.id === editing)!}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}
      {resetting && (
        <ResetPasswordDialog
          user={q.data!.users.find((u) => u.id === resetting)!}
          onClose={() => setResetting(null)}
          onSaved={() => setResetting(null)}
        />
      )}
    </div>
  );
}

function AddUserDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () =>
      api.createUser({
        username,
        displayName,
        email: email || null,
        password,
        isAdmin,
      }),
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Modal onClose={onClose} title="Add user">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (password.length < 12) {
            setError('Password must be at least 12 characters.');
            return;
          }
          mut.mutate();
        }}
        className="space-y-3"
      >
        <Field label="Username">
          <input
            required
            minLength={2}
            maxLength={64}
            pattern="[A-Za-z0-9_.\-]+"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Display name">
          <input
            required
            maxLength={128}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Email (optional)">
          <input
            type="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Temporary password (min 12)">
          <input
            type="password"
            required
            minLength={12}
            maxLength={512}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
          <PasswordStrengthBar password={password} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          Firm administrator
        </label>
        {error && <div className="text-sm text-rose-600">{error}</div>}
        <ModalFooter>
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button type="submit" disabled={mut.isPending} className="btn-primary">
            {mut.isPending ? 'Creating…' : 'Create user'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function EditUserDialog({
  user,
  onClose,
  onSaved,
}: {
  user: { id: string; displayName: string; email: string | null; isAdmin: boolean; isActive: boolean };
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email ?? '');
  const [isAdmin, setIsAdmin] = useState(user.isAdmin);
  const [isActive, setIsActive] = useState(user.isActive);
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () =>
      api.updateUser(user.id, {
        displayName: displayName !== user.displayName ? displayName : undefined,
        email: email !== (user.email ?? '') ? email || null : undefined,
        isAdmin: isAdmin !== user.isAdmin ? isAdmin : undefined,
        isActive: isActive !== user.isActive ? isActive : undefined,
      }),
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Modal onClose={onClose} title="Edit user">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          mut.mutate();
        }}
        className="space-y-3"
      >
        <Field label="Display name">
          <input
            required
            maxLength={128}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          Firm administrator
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active (can sign in)
        </label>
        {error && <div className="text-sm text-rose-600">{error}</div>}
        <ModalFooter>
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button type="submit" disabled={mut.isPending} className="btn-primary">
            {mut.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onSaved,
}: {
  user: { id: string; username: string };
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [adminPw, setAdminPw] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () => api.resetUserPassword(user.id, adminPw, pw),
    onSuccess: onSaved,
    onError: (e: Error) => {
      // Surface the specific admin-rechallenge failure so the operator knows
      // to retype rather than assuming the target's new password is bad.
      if (e.message.includes('admin_password_mismatch')) {
        setError('Your admin password was not accepted. Please retype it.');
      } else {
        setError(e.message);
      }
    },
  });
  return (
    <Modal onClose={onClose} title={`Reset password for @${user.username}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (pw !== pw2) return setError('Passwords do not match.');
          if (pw.length < 12) return setError('Password must be at least 12 characters.');
          if (!adminPw) return setError('Confirm your admin password to proceed.');
          mut.mutate();
        }}
        className="space-y-3"
      >
        <Field label="Your admin password">
          <input
            type="password"
            required
            autoComplete="current-password"
            value={adminPw}
            onChange={(e) => setAdminPw(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="New password (min 12)">
          <input
            type="password"
            required
            minLength={12}
            maxLength={512}
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            className="input"
          />
          <PasswordStrengthBar password={pw} />
        </Field>
        <Field label="Confirm">
          <input
            type="password"
            required
            minLength={12}
            maxLength={512}
            autoComplete="new-password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            className="input"
          />
        </Field>
        <p className="text-xs text-slate-500">
          The user will be signed out and must use the new password on their next sign-in.
        </p>
        {error && <div className="text-sm text-rose-600">{error}</div>}
        <ModalFooter>
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button type="submit" disabled={mut.isPending} className="btn-primary">
            {mut.isPending ? 'Resetting…' : 'Reset password'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function AdminGroups(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['groups'], queryFn: () => api.listGroups() });
  const usersQ = useQuery({ queryKey: ['users'], queryFn: () => api.listUsers() });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [managingMembers, setManagingMembers] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['groups'] });
  };
  const create = useMutation({
    mutationFn: () => api.createGroup({ name: newName }),
    onSuccess: () => {
      setCreating(false);
      setNewName('');
      invalidate();
    },
  });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.renameGroup(v.id, v.name),
    onSuccess: () => {
      setRenamingId(null);
      invalidate();
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteGroup(id),
    onSuccess: invalidate,
  });
  const groups = q.data?.groups ?? [];
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-900">Groups</h2>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-brand-600 text-white text-sm font-medium px-3 py-1.5 hover:bg-brand-700"
        >
          New group
        </button>
      </div>
      {creating && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim().length > 0) create.mutate();
          }}
          className="bg-white rounded shadow-card p-3 mb-3 flex gap-2 items-end"
        >
          <Field label="Name">
            <input
              autoFocus
              required
              maxLength={80}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="input"
            />
          </Field>
          <button type="submit" disabled={create.isPending} className="btn-primary">
            Create
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setNewName('');
            }}
            className="btn-ghost"
          >
            Cancel
          </button>
        </form>
      )}
      <ul className="bg-white rounded shadow-card divide-y divide-slate-100">
        {groups.map((g) => (
          <li key={g.id} className="p-3 flex items-center justify-between">
            <span>
              {renamingId === g.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (renameValue.trim().length > 0)
                      rename.mutate({ id: g.id, name: renameValue.trim() });
                  }}
                  className="flex gap-2 items-center"
                >
                  <input
                    autoFocus
                    required
                    maxLength={80}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    className="input"
                  />
                  <button type="submit" className="btn-primary">
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenamingId(null)}
                    className="btn-ghost"
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <strong>{g.name}</strong>
                  <span className="ml-2 text-xs text-slate-500">
                    {g.members.length} member{g.members.length === 1 ? '' : 's'}
                  </span>
                </>
              )}
            </span>
            <span className="flex items-center gap-3 text-sm">
              <button
                type="button"
                onClick={() => setManagingMembers(g.id)}
                className="text-brand-700 hover:underline"
              >
                Members
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenamingId(g.id);
                  setRenameValue(g.name);
                }}
                className="text-slate-600 hover:underline"
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete group "${g.name}"?`)) del.mutate(g.id);
                }}
                className="text-rose-600 hover:underline"
              >
                Delete
              </button>
              <span className="text-xs text-slate-400">sort: {g.sortOrder}</span>
            </span>
          </li>
        ))}
      </ul>
      {managingMembers && (
        <GroupMembersDialog
          group={groups.find((g) => g.id === managingMembers)!}
          allUsers={usersQ.data?.users ?? []}
          onClose={() => setManagingMembers(null)}
          onChanged={invalidate}
        />
      )}
    </div>
  );
}

function GroupMembersDialog({
  group,
  allUsers,
  onClose,
  onChanged,
}: {
  group: { id: string; name: string; members: string[] };
  allUsers: Array<{ id: string; displayName: string; username: string }>;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [toAdd, setToAdd] = useState('');
  const userById = new Map(allUsers.map((u) => [u.id, u]));
  const memberIds = new Set(group.members);
  const candidates = allUsers.filter((u) => !memberIds.has(u.id));
  const add = useMutation({
    mutationFn: (userId: string) => api.addGroupMember(group.id, userId),
    onSuccess: () => {
      setToAdd('');
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.removeGroupMember(group.id, userId),
    onSuccess: onChanged,
  });
  return (
    <Modal onClose={onClose} title={`Members of "${group.name}"`}>
      <div className="space-y-3">
        <ul className="divide-y divide-slate-100 bg-slate-50 rounded">
          {group.members.length === 0 && (
            <li className="p-3 text-sm text-slate-500">No members yet.</li>
          )}
          {group.members.map((userId) => {
            const u = userById.get(userId);
            return (
              <li key={userId} className="p-2 flex items-center justify-between text-sm">
                <span>{u ? `${u.displayName} (@${u.username})` : userId}</span>
                <button
                  type="button"
                  onClick={() => remove.mutate(userId)}
                  className="text-rose-600 hover:underline"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
        {candidates.length > 0 && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (toAdd) add.mutate(toAdd);
            }}
            className="flex gap-2 items-end"
          >
            <Field label="Add member">
              <select
                value={toAdd}
                onChange={(e) => setToAdd(e.target.value)}
                className="input"
              >
                <option value="">Select a user…</option>
                {candidates.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName} (@{u.username})
                  </option>
                ))}
              </select>
            </Field>
            <button type="submit" disabled={!toAdd || add.isPending} className="btn-primary">
              Add
            </button>
          </form>
        )}
        <ModalFooter>
          <button type="button" onClick={onClose} className="btn-ghost">
            Done
          </button>
        </ModalFooter>
      </div>
    </Modal>
  );
}

function Modal({
  children,
  onClose,
  title,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 bg-slate-900/40 grid place-items-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ModalFooter({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="flex justify-end gap-2 pt-2">{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="text-sm text-slate-700">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
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
    app_name: string | null;
    retention_days: number | null;
    stepup_timeout_hours: number;
    email_outbound_mode: 'summary' | 'content';
    sms_provider: 'textlink' | 'twilio' | 'mock';
    email_provider: 'mock' | 'postmark' | 'postfix';
    idle_lock_minutes: number;
    client_messaging_enabled: boolean;
    requests_enabled: boolean;
    vault_enabled: boolean;
    vault_folder_templates: VaultFolderTemplate[] | string | null;
    auto_nudge_enabled: boolean;
    auto_nudge_offsets_hours: number[] | null;
    message_edit_window_minutes: number;
    message_destruct_enabled: boolean;
    message_destruct_max_seconds: number;
  };
  // pg returns JSONB as parsed objects in most cases, but a few code paths
  // hand it back as a string — normalize defensively so the editor never
  // chokes on a serialized payload.
  const initialTemplates: VaultFolderTemplate[] = (() => {
    const v = s.vault_folder_templates;
    if (!v) return [];
    if (typeof v === 'string') {
      try {
        return JSON.parse(v) as VaultFolderTemplate[];
      } catch {
        return [];
      }
    }
    return v;
  })();
  return (
    <div className="p-4 max-w-lg space-y-4">
      <h2 className="font-semibold text-slate-900">Firm settings</h2>
      {!s.client_messaging_enabled && (
        <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-900 text-xs px-3 py-2">
          Client messaging is <strong>disabled</strong>. The portal refuses new sign-ins,
          inbound email/SMS are bounced, and staff cannot create new external conversations.
          Internal staff messaging is unaffected.
        </div>
      )}
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
        <span className="text-sm text-slate-700">
          App display name <span className="text-slate-400">(optional — replaces &quot;Vibe Connect&quot; in the staff app header and browser tab title)</span>
        </span>
        <input
          type="text"
          maxLength={80}
          defaultValue={s.app_name ?? ''}
          placeholder="Vibe Connect"
          onBlur={(e) => {
            const v = e.target.value.trim();
            mut.mutate({ appName: v.length > 0 ? v : null });
          }}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <div className="block">
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
        <RetentionRunButton />
      </div>
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
      <label className="flex items-start gap-2 text-sm text-slate-700 bg-white rounded shadow-card p-3">
        <input
          type="checkbox"
          defaultChecked={s.client_messaging_enabled}
          onChange={(e) => mut.mutate({ clientMessagingEnabled: e.target.checked })}
          className="mt-1"
        />
        <span>
          <strong>Enable client messaging</strong>
          <span className="block text-[11px] text-slate-500 mt-0.5">
            When off: the client portal refuses new sign-ins, inbound bridge email + SMS are
            bounced, and staff cannot create new external conversations. Existing external
            conversations remain readable for audit. Internal staff-only messaging is
            unaffected. Useful during incidents, firm onboarding, or before you&apos;ve tested
            your bridge provider in production.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm text-slate-700 bg-white rounded shadow-card p-3">
        <input
          type="checkbox"
          defaultChecked={s.requests_enabled}
          onChange={(e) => mut.mutate({ requestsEnabled: e.target.checked })}
          className="mt-1"
        />
        <span>
          <strong>Enable client requests</strong>
          <span className="block text-[11px] text-slate-500 mt-0.5">
            When off: the staff Requests panel + dashboard are hidden, the portal Requests
            tab is empty, the Requests API returns <code>403 requests_disabled</code>, and
            queued auto-nudges are dropped. Existing lists + items remain in the database
            and reappear when re-enabled. Internal messaging is unaffected.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm text-slate-700 bg-white rounded shadow-card p-3">
        <input
          type="checkbox"
          defaultChecked={s.vault_enabled}
          onChange={(e) => mut.mutate({ vaultEnabled: e.target.checked })}
          className="mt-1"
        />
        <span>
          <strong>Enable client files (Vault)</strong>
          <span className="block text-[11px] text-slate-500 mt-0.5">
            When off: the staff Files tab is hidden, the portal Files page shows a
            firm-disabled notice, and the Vault API returns <code>403 vault_disabled</code>.
            Existing files + folders + zone keys remain in the database and reappear when
            re-enabled. ClamAV scans, retention sweeps, and crypto-shred actions still run
            on existing rows. Internal messaging and client messaging are unaffected.
          </span>
        </span>
      </label>
      <VaultTemplateEditor
        initial={initialTemplates}
        onSave={(arr) => mut.mutate({ vaultFolderTemplates: arr })}
        disabled={!s.vault_enabled}
      />
      <fieldset
        className="rounded-md border border-slate-200 bg-white p-3 space-y-2"
        disabled={!s.requests_enabled}
      >
        <legend className="text-sm font-medium text-slate-800 px-1">
          Auto-nudge for request lists
        </legend>
        {!s.requests_enabled && (
          <p className="text-[11px] text-slate-500">
            Requests are currently disabled — auto-nudge settings have no effect until you
            re-enable them above.
          </p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            defaultChecked={s.auto_nudge_enabled}
            onChange={(e) => mut.mutate({ autoNudgeEnabled: e.target.checked })}
          />
          Send automatic reminders before a list is due
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-600">
            Offsets, in hours before due. Comma-separated, e.g. <code>72, 24, 0</code>.
          </span>
          <input
            type="text"
            defaultValue={(s.auto_nudge_offsets_hours ?? [72, 24, 0]).join(', ')}
            onBlur={(e) => {
              const parsed = e.target.value
                .split(',')
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isFinite(n) && n >= 0 && n <= 8760);
              mut.mutate({ autoNudgeOffsetsHours: parsed });
            }}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
          <p className="text-[11px] text-slate-500 mt-1">
            Each list with a due date enqueues one nudge per offset, capped at 3 nudges per
            list per 24 hours (manual + auto combined). Nudges that arrive after a list is
            already complete are silently dropped.
          </p>
        </label>
      </fieldset>

      <fieldset className="rounded-md border border-slate-200 bg-white p-3 space-y-2">
        <legend className="text-sm font-medium text-slate-800 px-1">
          Message lifecycle
        </legend>
        <label className="block">
          <span className="text-sm text-slate-700">Edit window (minutes)</span>
          <input
            type="number"
            min={0}
            max={1440}
            step={1}
            defaultValue={s.message_edit_window_minutes}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0 && v <= 1440)
                mut.mutate({ messageEditWindowMinutes: v });
            }}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <p className="text-[11px] text-slate-500 mt-1">
            How long after sending a staffer can edit a message. Each edit snapshots the
            prior ciphertext into the admin-recoverable history. <strong>0 = edits
            disabled</strong> (send-only). Max 1440 (24 h).
          </p>
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            defaultChecked={s.message_destruct_enabled}
            onChange={(e) => mut.mutate({ messageDestructEnabled: e.target.checked })}
            className="mt-1"
          />
          <span>
            <strong>Allow self-destruct timer on outbound messages</strong>
            <span className="block text-[11px] text-slate-500 mt-0.5">
              When on, the staff compose box gets a &quot;Self-destruct&quot; dropdown.
              The timer starts when the first non-sender recipient marks the message
              read; the server soft-deletes the row on fire (recipients see a
              &quot;Message deleted&quot; placeholder). Ciphertext is preserved for
              admin recovery via Message history. Best-effort: recipient devices may
              have cached plaintext (search index, scrollback) before the purge.
            </span>
          </span>
        </label>
        <label className="block">
          <span className="text-sm text-slate-700">Self-destruct max seconds</span>
          <input
            type="number"
            min={60}
            max={2_592_000}
            step={60}
            defaultValue={s.message_destruct_max_seconds}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 60 && v <= 2_592_000)
                mut.mutate({ messageDestructMaxSeconds: v });
            }}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <p className="text-[11px] text-slate-500 mt-1">
            Caps the compose dropdown so a staffer can&apos;t pick a value beyond this.
            7 days (604800) is the install default; 30 days (2592000) is the ceiling.
          </p>
        </label>
      </fieldset>

      <label className="block">
        <span className="text-sm text-slate-700">Idle auto-lock (minutes)</span>
        <input
          type="number"
          min={0}
          max={1440}
          step={1}
          defaultValue={s.idle_lock_minutes}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 0 && v <= 1440)
              mut.mutate({ idleLockMinutes: v });
          }}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <p className="text-[11px] text-slate-500 mt-1">
          After this many minutes with no keyboard or mouse input, the staff app clears
          the in-memory device key and asks for the device passphrase to resume.{' '}
          <strong>0 = never auto-lock</strong> (users can still click the 🔒 button).
          Max 1440 (24 hours).
        </p>
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
        <span className="text-sm text-slate-700">Email provider</span>
        <select
          defaultValue={s.email_provider}
          onChange={(e) => mut.mutate({ emailProvider: e.target.value })}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="mock">Mock (dev only — writes to .outbox/)</option>
          <option value="postmark">Postmark (transactional)</option>
          <option value="postfix">SMTP / Postfix (self-hosted relay)</option>
        </select>
        <span className="mt-1 text-[11px] text-slate-500 block">
          Configure credentials in <strong>Admin → Providers</strong> before switching off Mock.
        </span>
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
        <span className="mt-1 text-[11px] text-slate-500 block">
          Configure credentials in <strong>Admin → Providers</strong> before switching off Mock.
        </span>
      </label>
    </div>
  );
}

const AUDIT_PAGE = 50;

const AUDIT_ACTION_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All actions' },
  { value: 'admin.*', label: 'Admin actions' },
  { value: 'auth.*', label: 'Sign-ins' },
  { value: 'user.*', label: 'User device actions' },
  { value: 'attachment.*', label: 'Attachment events' },
  { value: 'portal.*', label: 'Portal events' },
  { value: 'email.*', label: 'Email bridge' },
  { value: 'sms.*', label: 'SMS bridge' },
  // Phase 24.8: surface every Phase 24 audit action under a single
  // "Requests" filter so a peer reviewer can pull the full chain
  // (list_created → item_created × N → item_submitted → item_marked_done →
  // list_completed) for an engagement in one filter.
  { value: 'request.*', label: 'Requests' },
  { value: 'install.complete', label: 'Install' },
];

function AdminAudit(): JSX.Element {
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const q = useQuery({
    queryKey: ['admin', 'audit', offset, action, since, until],
    queryFn: () => {
      const p = new URLSearchParams({ offset: String(offset), limit: String(AUDIT_PAGE) });
      if (action) p.set('action', action);
      if (since) p.set('since', new Date(since).toISOString());
      if (until) p.set('until', new Date(until).toISOString());
      return json<{
        hasMore: boolean;
        limit: number;
        offset: number;
        rows: Array<{
          id: string;
          action: string;
          targetType: string;
          targetId: string | null;
          createdAt: string;
          actorUserId: string | null;
          details: unknown;
          ipAddress: string | null;
        }>;
      }>(`/admin/audit?${p.toString()}`);
    },
    placeholderData: (previous) => previous,
  });
  const rows = q.data?.rows ?? [];
  const hasMore = q.data?.hasMore ?? false;
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-900">Audit log</h2>
        <div className="flex items-center gap-3">
          <label className="text-xs text-slate-600 flex items-center gap-2">
            Filter
            <select
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setOffset(0);
              }}
              className="rounded-md border border-slate-300 text-xs px-2 py-1"
            >
              {AUDIT_ACTION_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <a
            href={
              `/admin/audit?format=csv` +
              (action ? `&action=${encodeURIComponent(action)}` : '') +
              (since ? `&since=${encodeURIComponent(new Date(since).toISOString())}` : '') +
              (until ? `&until=${encodeURIComponent(new Date(until).toISOString())}` : '')
            }
            download
            className="btn-ghost text-xs"
            title="Download up to 10 000 matching rows as CSV"
          >
            Export CSV
          </a>
        </div>
      </div>
      <div className="flex items-center gap-3 mb-3 text-xs text-slate-600">
        <label className="flex items-center gap-2">
          From
          <input
            type="datetime-local"
            value={since}
            onChange={(e) => {
              setSince(e.target.value);
              setOffset(0);
            }}
            className="rounded-md border border-slate-300 text-xs px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-2">
          To
          <input
            type="datetime-local"
            value={until}
            onChange={(e) => {
              setUntil(e.target.value);
              setOffset(0);
            }}
            className="rounded-md border border-slate-300 text-xs px-2 py-1"
          />
        </label>
        {(since || until) && (
          <button
            type="button"
            onClick={() => {
              setSince('');
              setUntil('');
              setOffset(0);
            }}
            className="text-slate-500 hover:text-slate-800"
          >
            Clear range
          </button>
        )}
      </div>
      <table className="w-full text-xs bg-white rounded shadow-card">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="p-2">Time</th>
            <th className="p-2">Action</th>
            <th className="p-2">Actor</th>
            <th className="p-2">Target</th>
            <th className="p-2">IP</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-slate-100">
              <td className="p-2 whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td>
              <td className="p-2 font-mono">{r.action}</td>
              <td className="p-2 text-slate-600">{r.actorUserId?.slice(0, 8) ?? '—'}</td>
              <td className="p-2 text-slate-600">
                {r.targetType}
                {r.targetId ? ' · ' + r.targetId.slice(0, 8) : ''}
              </td>
              <td className="p-2 text-slate-500 whitespace-nowrap">{r.ipAddress ?? '—'}</td>
            </tr>
          ))}
          {rows.length === 0 && !q.isLoading && (
            <tr>
              <td className="p-3 text-slate-500" colSpan={5}>
                No audit rows match this filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="flex items-center justify-between mt-3 text-xs text-slate-600">
        <span>
          Showing {offset + 1}–{offset + rows.length}
          {q.isFetching && <span className="ml-2 text-slate-400">loading…</span>}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setOffset((o) => Math.max(0, o - AUDIT_PAGE))}
            disabled={offset === 0 || q.isFetching}
            className="btn-ghost"
          >
            ‹ Previous
          </button>
          <button
            type="button"
            onClick={() => setOffset((o) => o + AUDIT_PAGE)}
            disabled={!hasMore || q.isFetching}
            className="btn-ghost"
          >
            Next ›
          </button>
        </div>
      </div>
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

/**
 * Phase 26 — editor for `firm_settings.vault_folder_templates`.
 *
 * The list is small (≤64 entries by Zod cap) and edits are rare, so the
 * UX is "edit locally, click Save to ship the whole array." Mirrors how
 * `auto_nudge_offsets_hours` works elsewhere on this page — the server
 * accepts a full replacement array, not row-level patches.
 *
 * `{YYYY}` in `nameTemplate` is substituted at apply-time on the staff
 * client; we surface a small hint about that here.
 */
function VaultTemplateEditor({
  initial,
  onSave,
  disabled,
}: {
  initial: VaultFolderTemplate[];
  onSave: (next: VaultFolderTemplate[]) => void;
  disabled: boolean;
}): JSX.Element {
  const [rows, setRows] = useState<VaultFolderTemplate[]>(initial);
  const [dirty, setDirty] = useState(false);
  // Re-seed local state whenever the upstream value reloads — e.g. after a
  // successful save invalidates the query and refetches.
  useEffect(() => {
    setRows(initial);
    setDirty(false);
  }, [initial]);

  function update(idx: number, patch: Partial<VaultFolderTemplate>): void {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    setDirty(true);
  }
  function remove(idx: number): void {
    setRows((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }
  function add(): void {
    setRows((prev) => [
      ...prev,
      { nameTemplate: 'New folder', zone: 'shared', retentionDays: null },
    ]);
    setDirty(true);
  }

  return (
    <fieldset className="rounded-md border border-slate-200 bg-white p-3 space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-slate-800 px-1">Folder template</legend>
      <p className="text-[11px] text-slate-500">
        Default folders the staff app offers when applying a template to a client&apos;s vault.
        Use <code>{'{YYYY}'}</code> in a name to insert the current year at apply time.
      </p>
      {rows.length === 0 ? (
        <p className="text-[11px] text-slate-400">No template entries.</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="text-left font-medium pb-1">Name</th>
              <th className="text-left font-medium pb-1 w-28">Zone</th>
              <th className="text-left font-medium pb-1 w-28">Retention (days)</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx} className="border-t border-slate-100">
                <td className="py-1 pr-2">
                  <input
                    type="text"
                    value={row.nameTemplate}
                    onChange={(e) => update(idx, { nameTemplate: e.target.value })}
                    className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                </td>
                <td className="py-1 pr-2">
                  <select
                    value={row.zone}
                    onChange={(e) =>
                      update(idx, { zone: e.target.value as VaultFolderTemplate['zone'] })
                    }
                    className="rounded border border-slate-300 px-2 py-1 text-xs"
                  >
                    <option value="shared">Shared</option>
                    <option value="staff_only">Staff-only</option>
                  </select>
                </td>
                <td className="py-1 pr-2">
                  <input
                    type="number"
                    min={1}
                    max={36500}
                    value={row.retentionDays ?? ''}
                    placeholder="∞"
                    onChange={(e) =>
                      update(idx, {
                        retentionDays: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                    className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                </td>
                <td className="py-1 text-right">
                  <button
                    type="button"
                    onClick={() => remove(idx)}
                    className="text-slate-500 hover:text-red-700"
                    aria-label="Remove row"
                    title="Remove"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={add}
          className="text-xs rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
        >
          + Add row
        </button>
        <button
          type="button"
          onClick={() => {
            // Drop empty-name rows defensively; the server-side Zod schema
            // rejects them anyway and a stray blank entry wedges Apply Template.
            const cleaned = rows
              .map((r) => ({ ...r, nameTemplate: r.nameTemplate.trim() }))
              .filter((r) => r.nameTemplate.length > 0);
            onSave(cleaned);
          }}
          disabled={!dirty}
          className="ml-auto text-xs rounded-md bg-brand-600 text-white font-medium px-3 py-1 hover:bg-brand-700 disabled:opacity-50"
        >
          Save template
        </button>
      </div>
    </fieldset>
  );
}

function RetentionRunButton(): JSX.Element {
  const [result, setResult] = useState<
    null | {
      retentionDays: number | null;
      messagesShredded: number;
      attachmentsDeleted: number;
    }
  >(null);
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () =>
      json<{
        retentionDays: number | null;
        messagesShredded: number;
        attachmentsDeleted: number;
      }>(`/admin/retention/run`, { method: 'POST', body: '{}' }),
    onSuccess: (r) => {
      setResult(r);
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <div className="mt-2 text-xs text-slate-500 space-y-1">
      <p>
        The retention sweep runs once every 24 hours automatically. Click below to run it now —
        the first run after changing retention_days is the destructive one.
      </p>
      <button
        type="button"
        onClick={() => mut.mutate()}
        disabled={mut.isPending}
        className="btn-ghost"
      >
        {mut.isPending ? 'Running…' : 'Run retention sweep now'}
      </button>
      {error && <div className="text-rose-600">{error}</div>}
      {result && (
        <div className="text-emerald-700">
          {result.retentionDays === null
            ? 'Retention is disabled; nothing to do.'
            : `Sweep complete: ${result.messagesShredded} messages shredded, ${result.attachmentsDeleted} attachments deleted (retention = ${result.retentionDays} days).`}
        </div>
      )}
    </div>
  );
}

// ---------- Client directory (external identities) ----------

interface AdminClient {
  id: string;
  email: string;
  phone: string | null;
  displayName: string;
  firmClientRef: string | null;
  verificationType: 'ssn' | 'ein' | 'none';
  verificationRequired: boolean;
  firstInvitedAt: string;
  lastActiveAt: string | null;
  deactivatedAt: string | null;
  activeSessions: number;
  invitedAt: string | null;
  invitedVia: 'email' | 'sms' | null;
  invitePublicKey: string | null;
}

function AdminClients(): JSX.Element {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showDeactivated, setShowDeactivated] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // Firm metadata for the invite modal's preview pane + default reverify.
  // Cached globally via security-policy so it won't refetch here.
  const policyQ = useQuery({
    queryKey: ['security-policy'],
    queryFn: () => api.getSecurityPolicy(),
    staleTime: 60_000,
  });
  const firmName = policyQ.data?.firmName ?? 'Your Firm';
  const smsAvailable = Boolean(policyQ.data?.smsAvailable);
  const rawStepup = policyQ.data?.stepupTimeoutHours ?? 24;
  const defaultReverifyHours: 4 | 8 | 24 | 168 =
    rawStepup === 4 || rawStepup === 8 || rawStepup === 24 || rawStepup === 168 ? rawStepup : 24;
  const q = useQuery({
    queryKey: ['admin', 'clients', search, showDeactivated],
    queryFn: () => {
      const p = new URLSearchParams();
      if (search) p.set('search', search);
      if (showDeactivated) p.set('includeDeactivated', 'true');
      return json<{ clients: AdminClient[] }>(`/admin/clients${p.toString() ? `?${p}` : ''}`);
    },
    placeholderData: (prev) => prev,
  });
  const deactivate = useMutation({
    mutationFn: (id: string) =>
      json<{ ok: true; sessionsRevoked: number }>(`/admin/clients/${id}/deactivate`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'clients'] }),
  });
  const reactivate = useMutation({
    mutationFn: (id: string) =>
      json<{ ok: true }>(`/admin/clients/${id}/reactivate`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'clients'] }),
  });
  const forget = useMutation({
    mutationFn: (id: string) =>
      json<{ ok: true; anonymizedEmail: string }>(`/admin/clients/${id}/forget`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'clients'] }),
  });
  const reinvite = useMutation({
    mutationFn: ({ id, via }: { id: string; via?: 'email' | 'sms' }) =>
      api.reinviteClient(id, via),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'clients'] }),
  });
  const clients = q.data?.clients ?? [];
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-900">Clients</h2>
        <div className="flex items-center gap-3 text-xs text-slate-600">
          <label className="flex items-center gap-2">
            Search
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="name, email, phone, ref…"
              className="rounded-md border border-slate-300 text-xs px-2 py-1"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showDeactivated}
              onChange={(e) => setShowDeactivated(e.target.checked)}
            />
            Include deactivated
          </label>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="rounded-md bg-brand-600 text-white text-sm font-medium px-3 py-1.5 hover:bg-brand-700"
          >
            Add client
          </button>
        </div>
      </div>
      <InviteClientModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        firmName={firmName}
        defaultReverifyHours={defaultReverifyHours}
        smsAvailable={smsAvailable}
        autoStartConversation={false}
        showFirmClientRef={true}
        onCreated={(result) => {
          setAddOpen(false);
          void qc.invalidateQueries({ queryKey: ['admin', 'clients'] });
          const email = result.deliveryStatus.email;
          const sms = result.deliveryStatus.sms;
          const parts: string[] = [];
          if (email === 'sent') parts.push('email sent');
          else if (email === 'failed') parts.push('email failed');
          if (sms === 'sent') parts.push('SMS sent');
          else if (sms === 'failed') parts.push('SMS failed');
          setFlash(
            `Invited ${result.displayName}${parts.length > 0 ? ` — ${parts.join(', ')}` : ''}.`,
          );
          // Self-clear so the row's normal "pending" state takes over.
          window.setTimeout(() => setFlash(null), 6_000);
        }}
        onOpenExistingClient={(_clientId, existingName) => {
          // Duplicate path — the admin /clients search matches on name /
          // email / phone / firm_ref. Narrow the table to the conflicting
          // row by name so the admin can inspect / resend / forget without
          // leaving the page.
          setAddOpen(false);
          setSearch(existingName);
          setFlash(`Filtered to the existing record for "${existingName}".`);
          window.setTimeout(() => setFlash(null), 6_000);
        }}
      />
      {flash && (
        <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-900 text-xs px-3 py-2">
          {flash}
        </div>
      )}
      <p className="text-xs text-slate-500 mb-2">
        Clients (external identities) who can sign in to the portal or receive bridged email /
        SMS. Deactivating blocks all future portal access and revokes any live sessions; their
        conversation membership is preserved for audit.
      </p>
      <table className="w-full text-xs bg-white rounded shadow-card">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="p-2">Name</th>
            <th className="p-2">Email</th>
            <th className="p-2">Phone</th>
            <th className="p-2">Last active</th>
            <th className="p-2">Sessions</th>
            <th className="p-2">Status</th>
            <th className="p-2"></th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.id} className="border-b border-slate-100">
              <td className="p-2">
                {c.displayName}
                {c.firmClientRef && (
                  <span className="ml-1 text-slate-400">[{c.firmClientRef}]</span>
                )}
              </td>
              <td className="p-2 text-slate-600">{c.email}</td>
              <td className="p-2 text-slate-600">{c.phone ?? '—'}</td>
              <td className="p-2 whitespace-nowrap">
                {c.lastActiveAt ? new Date(c.lastActiveAt).toLocaleString() : '—'}
              </td>
              <td className="p-2">{c.activeSessions}</td>
              <td className="p-2">
                {c.deactivatedAt ? (
                  <span className="text-rose-700">deactivated</span>
                ) : (
                  <span className="text-emerald-700">active</span>
                )}
              </td>
              <td className="p-2 text-right whitespace-nowrap space-x-3">
                {!c.deactivatedAt && !c.lastActiveAt && (
                  <button
                    type="button"
                    onClick={() =>
                      reinvite.mutate({
                        id: c.id,
                        via: c.invitedVia ?? (c.email ? 'email' : 'sms'),
                      })
                    }
                    disabled={reinvite.isPending}
                    className="text-brand-700 hover:underline disabled:opacity-50"
                    title={
                      c.invitedAt
                        ? `Last invite sent ${new Date(c.invitedAt).toLocaleString()} — resending rotates the link.`
                        : 'Send invite link'
                    }
                  >
                    {c.invitedAt ? 'Resend invite' : 'Send invite'}
                  </button>
                )}
                {c.deactivatedAt ? (
                  <button
                    type="button"
                    onClick={() => reactivate.mutate(c.id)}
                    className="text-brand-700 hover:underline"
                  >
                    Reactivate
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Deactivate ${c.displayName}? Revokes ${c.activeSessions} active session(s) immediately.`))
                        deactivate.mutate(c.id);
                    }}
                    className="text-rose-600 hover:underline"
                  >
                    Deactivate
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const msg =
                      `Forget ${c.displayName}?\n\n` +
                      `This IRREVERSIBLY scrubs their name, email, phone, and client ref from the record. ` +
                      `Past messages they sent remain (as ciphertext) attributed to an anonymous placeholder. ` +
                      `Use this to satisfy a right-to-erasure request.`;
                    if (confirm(msg)) forget.mutate(c.id);
                  }}
                  className="text-rose-700 hover:underline"
                >
                  Forget
                </button>
              </td>
            </tr>
          ))}
          {clients.length === 0 && !q.isLoading && (
            <tr>
              <td className="p-3 text-slate-500" colSpan={7}>
                {search || !showDeactivated ? 'No clients match this filter.' : 'No clients yet.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Client portal sessions ----------

function AdminClientSessions(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'client-sessions'],
    queryFn: () =>
      json<{
        sessions: Array<{
          id: string;
          externalIdentityId: string;
          createdAt: string;
          expiresAt: string;
          lastSeenAt: string | null;
          verifiedUntil: string | null;
          userAgent: string | null;
          ipAddress: string | null;
          displayName: string;
          email: string;
          phone: string | null;
        }>;
      }>(`/admin/client-sessions`),
    refetchInterval: 30_000,
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      json<{ ok: true }>(`/admin/client-sessions/${id}/revoke`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'client-sessions'] }),
  });
  return (
    <div className="p-4">
      <h2 className="font-semibold text-slate-900 mb-3">Active client portal sessions</h2>
      <p className="text-xs text-slate-500 mb-2">
        Everyone currently signed into the client portal. Revoke to force sign-out.
        Refreshes every 30 s.
      </p>
      <table className="w-full text-xs bg-white rounded shadow-card">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="p-2">Client</th>
            <th className="p-2">Contact</th>
            <th className="p-2">Last seen</th>
            <th className="p-2">Step-up until</th>
            <th className="p-2">Expires</th>
            <th className="p-2">IP</th>
            <th className="p-2"></th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.sessions ?? []).map((s) => (
            <tr key={s.id} className="border-b border-slate-100">
              <td className="p-2">{s.displayName}</td>
              <td className="p-2 text-slate-600">{s.email ?? s.phone ?? '—'}</td>
              <td className="p-2 whitespace-nowrap">
                {s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '—'}
              </td>
              <td className="p-2 whitespace-nowrap">
                {s.verifiedUntil ? new Date(s.verifiedUntil).toLocaleString() : '—'}
              </td>
              <td className="p-2 whitespace-nowrap">{new Date(s.expiresAt).toLocaleString()}</td>
              <td className="p-2 text-slate-500 whitespace-nowrap">{s.ipAddress ?? '—'}</td>
              <td className="p-2 text-right">
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Revoke session for ${s.displayName}?`)) revoke.mutate(s.id);
                  }}
                  className="text-rose-600 hover:underline"
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
          {(q.data?.sessions ?? []).length === 0 && !q.isLoading && (
            <tr>
              <td className="p-3 text-slate-500" colSpan={7}>
                No clients are currently signed in to the portal.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------- SMS audit + opt-ins ----------

function AdminSms(): JSX.Element {
  const status = useQuery({
    queryKey: ['admin', 'sms', 'status'],
    queryFn: () =>
      json<{
        provider: string;
        monthlyCap: number;
        monthSent: number;
        percent: number;
        capAlerts: { eighty: boolean; hundred: boolean };
      }>(`/admin/sms/status`),
    refetchInterval: 60_000,
  });
  const optIns = useQuery({
    queryKey: ['admin', 'sms', 'opt-ins'],
    queryFn: () =>
      json<{
        rows: Array<{
          externalIdentityId: string;
          optedInAt: string;
          optedOutAt: string | null;
          lastStopKeywordAt: string | null;
          provider: string;
          source: string;
          displayName: string | null;
          phone: string | null;
        }>;
      }>(`/admin/sms/opt-ins`),
  });
  const audit = useQuery({
    queryKey: ['admin', 'sms', 'audit'],
    queryFn: () =>
      json<{
        rows: Array<{
          id: string;
          created_at: string;
          action: string;
          actor_external_identity_id: string | null;
          details: unknown;
        }>;
      }>(`/admin/sms/audit`),
  });
  const s = status.data;
  return (
    <div className="p-4 space-y-6">
      <div>
        <h2 className="font-semibold text-slate-900 mb-2">SMS status</h2>
        {s ? (
          <div className="bg-white rounded shadow-card p-3 text-sm flex items-center gap-6">
            <div>
              <div className="text-xs text-slate-500">Provider</div>
              <div className="font-mono">{s.provider}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">This month</div>
              <div>
                {s.monthSent} / {s.monthlyCap}{' '}
                <span
                  className={
                    s.capAlerts.hundred
                      ? 'text-rose-600'
                      : s.capAlerts.eighty
                        ? 'text-amber-700'
                        : 'text-emerald-700'
                  }
                >
                  ({s.percent}%)
                </span>
              </div>
            </div>
            {s.capAlerts.hundred && (
              <div className="text-rose-700 text-xs">Monthly SMS cap reached — outbound blocked.</div>
            )}
            {!s.capAlerts.hundred && s.capAlerts.eighty && (
              <div className="text-amber-700 text-xs">≥80% of cap; consider raising it.</div>
            )}
          </div>
        ) : (
          <div className="text-sm text-slate-500">Loading…</div>
        )}
      </div>
      <div>
        <h3 className="font-medium text-slate-900 mb-2">SMS opt-ins (TCPA audit)</h3>
        <table className="w-full text-xs bg-white rounded shadow-card">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200">
              <th className="p-2">Client</th>
              <th className="p-2">Phone</th>
              <th className="p-2">Opted in</th>
              <th className="p-2">Opted out</th>
              <th className="p-2">Last STOP</th>
              <th className="p-2">Provider</th>
              <th className="p-2">Source</th>
            </tr>
          </thead>
          <tbody>
            {(optIns.data?.rows ?? []).map((r) => (
              <tr key={r.externalIdentityId} className="border-b border-slate-100">
                <td className="p-2">{r.displayName ?? '—'}</td>
                <td className="p-2 font-mono">{r.phone ?? '—'}</td>
                <td className="p-2 whitespace-nowrap">
                  {new Date(r.optedInAt).toLocaleString()}
                </td>
                <td className="p-2 whitespace-nowrap">
                  {r.optedOutAt ? new Date(r.optedOutAt).toLocaleString() : '—'}
                </td>
                <td className="p-2 whitespace-nowrap">
                  {r.lastStopKeywordAt ? new Date(r.lastStopKeywordAt).toLocaleString() : '—'}
                </td>
                <td className="p-2">{r.provider}</td>
                <td className="p-2">{r.source}</td>
              </tr>
            ))}
            {(optIns.data?.rows ?? []).length === 0 && !optIns.isLoading && (
              <tr>
                <td className="p-3 text-slate-500" colSpan={7}>
                  No SMS opt-in records yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div>
        <h3 className="font-medium text-slate-900 mb-2">Recent SMS events</h3>
        <table className="w-full text-xs bg-white rounded shadow-card">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200">
              <th className="p-2">Time</th>
              <th className="p-2">Action</th>
              <th className="p-2">Client</th>
              <th className="p-2">Details</th>
            </tr>
          </thead>
          <tbody>
            {(audit.data?.rows ?? []).map((r) => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className="p-2 whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                <td className="p-2 font-mono">{r.action}</td>
                <td className="p-2 text-slate-600 font-mono text-[10px]">
                  {r.actor_external_identity_id?.slice(0, 8) ?? '—'}
                </td>
                <td className="p-2 text-slate-600 font-mono text-[10px] truncate max-w-xs">
                  {r.details ? JSON.stringify(r.details) : ''}
                </td>
              </tr>
            ))}
            {(audit.data?.rows ?? []).length === 0 && !audit.isLoading && (
              <tr>
                <td className="p-3 text-slate-500" colSpan={4}>
                  No SMS events in the window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Conversation export ----------

interface AdminConversation {
  id: string;
  type: 'internal' | 'external';
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  memberCount: number;
}

function AdminExport(): JSX.Element {
  const [type, setType] = useState<'' | 'internal' | 'external'>('');
  const q = useQuery({
    queryKey: ['admin', 'conversations', type],
    queryFn: () =>
      json<{ conversations: AdminConversation[] }>(
        `/admin/conversations?limit=100${type ? `&type=${type}` : ''}`,
      ),
  });
  const [exporting, setExporting] = useState<AdminConversation | null>(null);
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-900">Export conversation</h2>
        <label className="text-xs text-slate-600 flex items-center gap-2">
          Type
          <select
            value={type}
            onChange={(e) => setType(e.target.value as '' | 'internal' | 'external')}
            className="rounded-md border border-slate-300 text-xs px-2 py-1"
          >
            <option value="">All</option>
            <option value="internal">Internal</option>
            <option value="external">External (with clients)</option>
          </select>
        </label>
      </div>
      <p className="text-xs text-slate-500 mb-2">
        Export returns the raw ciphertext + wrapped keys. Decrypt locally with an enrolled
        device key or the firm recovery phrase. Every export writes an audit row.
      </p>
      <table className="w-full text-xs bg-white rounded shadow-card">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="p-2">ID</th>
            <th className="p-2">Type</th>
            <th className="p-2">Name</th>
            <th className="p-2">Members</th>
            <th className="p-2">Messages</th>
            <th className="p-2">Updated</th>
            <th className="p-2"></th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.conversations ?? []).map((c) => (
            <tr key={c.id} className="border-b border-slate-100">
              <td className="p-2 font-mono text-[10px]">{c.id.slice(0, 8)}</td>
              <td className="p-2">{c.type}</td>
              <td className="p-2">{c.displayName ?? <em className="text-slate-400">—</em>}</td>
              <td className="p-2">{c.memberCount}</td>
              <td className="p-2">{c.messageCount}</td>
              <td className="p-2 whitespace-nowrap">{new Date(c.updatedAt).toLocaleString()}</td>
              <td className="p-2 text-right">
                <button
                  type="button"
                  onClick={() => setExporting(c)}
                  className="text-brand-700 hover:underline"
                >
                  Export
                </button>
              </td>
            </tr>
          ))}
          {(q.data?.conversations ?? []).length === 0 && !q.isLoading && (
            <tr>
              <td className="p-3 text-slate-500" colSpan={7}>
                No conversations match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {exporting && (
        <ExportDialog
          conversation={exporting}
          onClose={() => setExporting(null)}
        />
      )}
    </div>
  );
}

function ExportDialog({
  conversation,
  onClose,
}: {
  conversation: AdminConversation;
  onClose: () => void;
}): JSX.Element {
  const [phrase, setPhrase] = useState('');
  const [includeTeamNotes, setIncludeTeamNotes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: async (): Promise<void> => {
      const words = phrase
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0);
      const r = await fetch(appUrl('/admin/export'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversation.id,
          recoveryPhrase: words.length === 24 ? words : undefined,
          includeTeamNotes,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}) as { error?: string });
        throw new Error(
          (body as { error?: string }).error === 'recovery_phrase_required'
            ? 'This is an external conversation; the firm requires the 24-word recovery phrase to export.'
            : `Export failed: ${r.status}`,
        );
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `conversation-${conversation.id.slice(0, 8)}-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    onSuccess: () => {
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Modal onClose={onClose} title="Export conversation">
      <div className="space-y-3">
        <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded p-2 space-y-1">
          <div>
            <strong>ID:</strong> <span className="font-mono">{conversation.id}</span>
          </div>
          <div>
            <strong>Type:</strong> {conversation.type}
          </div>
          <div>
            <strong>Messages:</strong> {conversation.messageCount}
          </div>
        </div>
        <p className="text-xs text-slate-500">
          This returns raw ciphertext + the per-conversation wrapped key bundle.
          Decryption happens locally on your device (or offline with the recovery phrase) — the
          server never sees plaintext.
        </p>
        {conversation.type === 'external' && (
          <label className="block">
            <span className="text-sm text-slate-700">
              Recovery phrase <span className="text-slate-400">(if firm policy requires)</span>
            </span>
            <textarea
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              rows={3}
              placeholder="24 space-separated words"
              className="input font-mono text-xs"
            />
            <p className="text-[10px] text-slate-500 mt-1">
              Not sent anywhere — only forwarded to this server for the single export call.
              Never stored.
            </p>
          </label>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={includeTeamNotes}
            onChange={(e) => setIncludeTeamNotes(e.target.checked)}
          />
          Include internal team-notes side-thread (if any)
        </label>
        {error && <div className="text-sm text-rose-600">{error}</div>}
        <ModalFooter>
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
            className="btn-primary"
          >
            {mut.isPending ? 'Exporting…' : 'Download JSON'}
          </button>
        </ModalFooter>
      </div>
    </Modal>
  );
}

// ---------- Recovery phrase: Shamir secret sharing ----------
//
// This is a pure client-side tool. Neither the typed phrase nor the generated shares
// ever leave the browser. The server has no recovery_shares table by design — shares are
// distributed to partners and physically stored outside Vibe Connect.
interface MessageHistoryBundle {
  conversation: { id: string; type: string; displayName: string | null } | null;
  message: {
    id: string;
    senderId: string | null;
    senderExternalIdentityId: string | null;
    ciphertext: string;
    ciphertextMeta: Record<string, unknown> | null;
    contentKeyVersion: number;
    source: string;
    createdAt: string;
    editedAt: string | null;
    deletedAt: string | null;
    destructAfterViewSeconds: number | null;
    destructAt: string | null;
  };
  edits: Array<{
    id: string;
    ciphertext: string;
    ciphertextMeta: Record<string, unknown>;
    contentKeyVersion: number;
    replacedAt: string;
    replacedByUserId: string | null;
  }>;
  conversationKeys: Array<{ rotationVersion: number; wrappedKeys: Record<string, string> }>;
}

function AdminMessageHistory(): JSX.Element {
  // Phase 27: pull the prior versions + final state of an edited or deleted
  // message. The actual decrypt happens locally — admins enrolled on this
  // device can decrypt directly via the conversation's wrappedKeys; an admin
  // without a device key in the bundle should download the JSON and decrypt
  // offline with the recovery phrase (same flow as Export).
  const [messageId, setMessageId] = useState('');
  const [bundle, setBundle] = useState<MessageHistoryBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetcher = useMutation({
    mutationFn: async (id: string): Promise<MessageHistoryBundle> => {
      const r = await fetch(appUrl(`/admin/messages/${id}/history`), {
        credentials: 'include',
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${r.status}`);
      }
      return (await r.json()) as MessageHistoryBundle;
    },
    onSuccess: (b) => {
      setBundle(b);
      setError(null);
    },
    onError: (e: Error) => {
      setBundle(null);
      setError(e.message);
    },
  });
  function downloadJson(): void {
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `message-history-${bundle.message.id.slice(0, 8)}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="p-4 space-y-4">
      <h2 className="font-semibold text-slate-900">Message history</h2>
      <p className="text-xs text-slate-500 max-w-prose">
        Returns the live message + every prior ciphertext snapshot from before each edit, plus
        the conversation&apos;s wrapped-key bundle. Decrypt locally with an enrolled device key or
        the firm recovery phrase. Every lookup writes an audit row.
      </p>
      <div className="flex items-end gap-2">
        <label className="block flex-1 max-w-md">
          <span className="text-sm text-slate-700">Message ID</span>
          <input
            type="text"
            value={messageId}
            onChange={(e) => setMessageId(e.target.value.trim())}
            placeholder="00000000-0000-0000-0000-000000000000"
            className="input font-mono text-xs"
          />
        </label>
        <button
          type="button"
          onClick={() => fetcher.mutate(messageId)}
          disabled={!messageId || fetcher.isPending}
          className="btn-primary"
        >
          {fetcher.isPending ? 'Loading…' : 'Load'}
        </button>
      </div>
      {error && (
        <div className="text-sm text-rose-600">
          {error === 'not_found' ? 'No such message.' : `Error: ${error}`}
        </div>
      )}
      {bundle && (
        <div className="space-y-3 text-xs">
          <div className="bg-slate-50 border border-slate-200 rounded p-3 space-y-1">
            <div>
              <strong>Conversation:</strong>{' '}
              <span className="font-mono">{bundle.conversation?.id ?? '—'}</span>{' '}
              {bundle.conversation && (
                <span className="text-slate-500">
                  ({bundle.conversation.type} · {bundle.conversation.displayName ?? 'no name'})
                </span>
              )}
            </div>
            <div>
              <strong>Created:</strong> {new Date(bundle.message.createdAt).toLocaleString()}
            </div>
            {bundle.message.editedAt && (
              <div>
                <strong>Last edited:</strong>{' '}
                {new Date(bundle.message.editedAt).toLocaleString()}
              </div>
            )}
            {bundle.message.deletedAt && (
              <div className="text-amber-700">
                <strong>Deleted:</strong>{' '}
                {new Date(bundle.message.deletedAt).toLocaleString()}
              </div>
            )}
            {bundle.message.destructAt && (
              <div className="text-amber-700">
                <strong>Self-destruct fired:</strong>{' '}
                {new Date(bundle.message.destructAt).toLocaleString()}
              </div>
            )}
            <div>
              <strong>Sender (user):</strong>{' '}
              <span className="font-mono">{bundle.message.senderId ?? '—'}</span>
            </div>
            <div>
              <strong>Sender (external):</strong>{' '}
              <span className="font-mono">
                {bundle.message.senderExternalIdentityId ?? '—'}
              </span>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="font-semibold text-slate-800">Timeline</h3>
            <ol className="space-y-2">
              {bundle.edits.map((e, i) => (
                <li
                  key={e.id}
                  className="bg-white border border-slate-200 rounded p-2 space-y-1"
                >
                  <div className="text-slate-500">
                    Version {i + 1} (replaced{' '}
                    {new Date(e.replacedAt).toLocaleString()}{' '}
                    {e.replacedByUserId ? `by ${e.replacedByUserId.slice(0, 8)}` : ''})
                  </div>
                  <div className="font-mono break-all text-[10px] text-slate-700">
                    {e.ciphertext.slice(0, 80)}
                    {e.ciphertext.length > 80 && '…'}
                  </div>
                  <div className="text-slate-400">
                    {e.ciphertext.length} bytes · key v{e.contentKeyVersion}
                  </div>
                </li>
              ))}
              <li className="bg-white border border-emerald-300 rounded p-2 space-y-1">
                <div className="text-emerald-700 font-medium">
                  Current{bundle.message.deletedAt ? ' (DELETED)' : ''}
                </div>
                <div className="font-mono break-all text-[10px] text-slate-700">
                  {bundle.message.ciphertext.slice(0, 80)}
                  {bundle.message.ciphertext.length > 80 && '…'}
                </div>
                <div className="text-slate-400">
                  {bundle.message.ciphertext.length} bytes · key v
                  {bundle.message.contentKeyVersion}
                </div>
              </li>
            </ol>
          </div>
          <div>
            <button type="button" onClick={downloadJson} className="btn-ghost">
              Download bundle (JSON)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AdminRecovery(): JSX.Element {
  return (
    <div className="p-4 max-w-2xl space-y-6">
      <div>
        <h2 className="font-semibold text-slate-900 mb-2">Firm recovery phrase</h2>
        <p className="text-sm text-slate-600">
          The 24-word firm recovery phrase you wrote down at install time is the only way to
          decrypt firm-wide conversations without any enrolled device. This tool helps you split
          it across multiple partners using Shamir Secret Sharing so no single partner can act
          alone.
        </p>
        <p className="text-sm text-rose-700 mt-2">
          Everything here is client-side. Nothing you type or see is sent to the server. Close
          the tab when done and never paste these values anywhere searchable.
        </p>
      </div>
      <RecoverConversationsForm />
      <hr className="border-slate-200" />
      <SplitPhraseForm />
      <hr className="border-slate-200" />
      <CombinePhraseForm />
    </div>
  );
}

function RecoverConversationsForm(): JSX.Element {
  const { device, recipientId: getRecipientId } = useCrypto();
  const [phraseText, setPhraseText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onRun(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const words = phraseText
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);
      if (words.length !== 24) {
        throw new Error(`Expected 24 words, got ${words.length}.`);
      }
      const rid = getRecipientId();
      if (!device || !rid) {
        throw new Error('This browser has no enrolled device yet. Complete enrollment first.');
      }
      const crypto = await import('@vibe-connect/crypto');
      await crypto.ready();
      const { runRecoveryRewrap } = await import('../state/recovery.js');
      const out = await runRecoveryRewrap({
        crypto,
        recoveryPhrase: words,
        myRecipientId: rid,
        myDevicePublicKey: device.publicKey,
      });
      const parts = [
        `Scanned ${out.scanned} conversation${out.scanned === 1 ? '' : 's'}.`,
        out.recovered > 0 ? `Recovered ${out.recovered}.` : null,
        out.alreadyHad > 0 ? `${out.alreadyHad} already readable.` : null,
        out.skippedNoFirmEntry > 0
          ? `${out.skippedNoFirmEntry} pre-date firm-key wrapping and can't be recovered with the phrase.`
          : null,
        out.errors.length > 0 ? `${out.errors.length} errored.` : null,
      ].filter(Boolean);
      setResult(parts.join(' '));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setPhraseText(''); // wipe from the state binding after use
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="font-medium text-slate-900">Recover conversations on this device</h3>
      <p className="text-xs text-slate-600">
        Use this when every one of your other devices has been revoked or is offline. Paste the
        24-word recovery phrase; this browser will derive the firm private key locally, unwrap
        every conversation that was wrapped to the firm key, and re-seal a copy to{' '}
        <strong>this device</strong> so you can read history again. The phrase never leaves your
        browser.
      </p>
      <label className="block">
        <span className="text-sm text-slate-700">24-word recovery phrase</span>
        <textarea
          value={phraseText}
          onChange={(e) => setPhraseText(e.target.value)}
          rows={3}
          autoComplete="off"
          spellCheck={false}
          className="input font-mono"
          placeholder="word1 word2 word3 …"
        />
      </label>
      <button
        type="button"
        onClick={() => void onRun()}
        disabled={busy || phraseText.trim().length === 0}
        className="rounded-md bg-brand-600 text-white font-medium px-4 py-2 text-sm hover:bg-brand-700 disabled:opacity-60"
      >
        {busy ? 'Recovering…' : 'Recover this device'}
      </button>
      {result && <div className="text-sm text-emerald-700">{result}</div>}
      {error && <div className="text-sm text-rose-700">{error}</div>}
    </section>
  );
}

function SplitPhraseForm(): JSX.Element {
  const [phrase, setPhrase] = useState('');
  const [threshold, setThreshold] = useState(2);
  const [total, setTotal] = useState(3);
  const [shares, setShares] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(): void {
    setError(null);
    setShares([]);
    try {
      const out = splitRecoveryPhrase(phrase, threshold, total);
      setShares(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="font-medium text-slate-900">Split a recovery phrase into shares</h3>
      <label className="block">
        <span className="text-sm text-slate-700">24-word phrase</span>
        <textarea
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          rows={3}
          autoComplete="off"
          spellCheck={false}
          className="input font-mono"
          placeholder="word1 word2 word3 …"
        />
      </label>
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm text-slate-700">Threshold (K)</span>
          <input
            type="number"
            min={2}
            max={total}
            value={threshold}
            onChange={(e) => setThreshold(Math.max(2, Math.min(255, Number(e.target.value))))}
            className="input"
          />
        </label>
        <label className="block">
          <span className="text-sm text-slate-700">Total shares (N)</span>
          <input
            type="number"
            min={threshold}
            max={255}
            value={total}
            onChange={(e) => setTotal(Math.max(threshold, Math.min(255, Number(e.target.value))))}
            className="input"
          />
        </label>
      </div>
      <p className="text-xs text-slate-500">
        Any <strong>{threshold}</strong> of the <strong>{total}</strong> shares together
        reconstruct the phrase. Fewer than {threshold} reveal nothing.
      </p>
      {error && <div className="text-sm text-rose-600">{error}</div>}
      <button type="button" onClick={onSubmit} className="btn-primary">
        Generate shares
      </button>

      {shares.length > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-md p-3 space-y-2">
          <p className="text-sm text-amber-900">
            Write each share down separately and hand it to a different partner. Do not store
            multiple shares in the same place.
          </p>
          <ol className="space-y-1">
            {shares.map((s, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-500 w-16">Share {i + 1}</span>
                <code className="flex-1 bg-white border border-amber-200 rounded px-2 py-1 text-xs break-all">
                  {s}
                </code>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(s)}
                  className="text-xs text-brand-700 hover:underline"
                >
                  Copy
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function CombinePhraseForm(): JSX.Element {
  const [sharesText, setSharesText] = useState('');
  const [phrase, setPhrase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(): void {
    setError(null);
    setPhrase(null);
    const lines = sharesText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length < 2) {
      setError('Paste at least two shares, one per line.');
      return;
    }
    try {
      const out = combineRecoveryShares(lines);
      setPhrase(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="font-medium text-slate-900">Reconstruct a phrase from shares</h3>
      <label className="block">
        <span className="text-sm text-slate-700">Shares (one per line)</span>
        <textarea
          value={sharesText}
          onChange={(e) => setSharesText(e.target.value)}
          rows={5}
          autoComplete="off"
          spellCheck={false}
          className="input font-mono"
          placeholder="V1-01-…&#10;V1-02-…&#10;V1-03-…"
        />
      </label>
      {error && <div className="text-sm text-rose-600">{error}</div>}
      <button type="button" onClick={onSubmit} className="btn-primary">
        Reconstruct phrase
      </button>
      {phrase && (
        <div className="bg-emerald-50 border border-emerald-300 rounded-md p-3 space-y-2">
          <p className="text-sm text-emerald-900">
            Reconstructed. Verify the 24 words match your original record.
          </p>
          <code className="block bg-white border border-emerald-200 rounded px-2 py-2 text-sm break-words">
            {phrase}
          </code>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(phrase)}
            className="text-xs text-brand-700 hover:underline"
          >
            Copy
          </button>
        </div>
      )}
    </section>
  );
}

// ---------- Bulk CSV user import ----------

interface ParsedUserRow {
  line: number;
  username: string;
  displayName: string;
  email: string;
  initialPassword: string;
  isAdmin: boolean;
  errors: string[];
}

function BulkImportDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedUserRow[]>([]);
  const [result, setResult] = useState<{
    created: string[];
    skipped: Array<{ username: string; reason: string }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: (users: Array<ParsedUserRow>) =>
      api.bulkImportUsers(
        users.map((u) => ({
          username: u.username,
          email: u.email || undefined,
          displayName: u.displayName,
          initialPassword: u.initialPassword,
          isAdmin: u.isAdmin,
        })),
      ),
    onSuccess: (r) => {
      setResult(r);
      onDone();
    },
    onError: (e: Error) => setError(e.message),
  });

  function onParse(): void {
    setError(null);
    setResult(null);
    try {
      const rows = parseCsv(text);
      if (rows.length === 0) {
        setParsed([]);
        setError('No rows found. First line must be the header.');
        return;
      }
      const header = rows[0]!.map((h) => h.trim().toLowerCase());
      const required = ['username', 'displayname', 'initialpassword'];
      const missing = required.filter((r) => !header.includes(r));
      if (missing.length > 0) {
        setParsed([]);
        setError(`Missing required column(s): ${missing.join(', ')}`);
        return;
      }
      const idx = {
        username: header.indexOf('username'),
        displayName: header.indexOf('displayname'),
        email: header.indexOf('email'),
        initialPassword: header.indexOf('initialpassword'),
        isAdmin: header.indexOf('isadmin'),
      };
      const out: ParsedUserRow[] = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]!;
        if (r.every((cell) => cell.trim() === '')) continue; // blank line
        const username = (r[idx.username] ?? '').trim();
        const displayName = (r[idx.displayName] ?? '').trim();
        const email = idx.email >= 0 ? (r[idx.email] ?? '').trim() : '';
        const initialPassword = (r[idx.initialPassword] ?? '').trim();
        const isAdmin =
          idx.isAdmin >= 0 ? /^(1|true|yes|y)$/i.test((r[idx.isAdmin] ?? '').trim()) : false;
        const errors: string[] = [];
        if (!/^[A-Za-z0-9_.-]{2,64}$/.test(username))
          errors.push('username must be 2-64 chars [A-Za-z0-9_.-]');
        if (!displayName || displayName.length > 128)
          errors.push('displayName must be 1-128 chars');
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
          errors.push('email invalid');
        if (initialPassword.length < 12)
          errors.push('initialPassword must be ≥12 chars');
        out.push({
          line: i + 1,
          username,
          displayName,
          email,
          initialPassword,
          isAdmin,
          errors,
        });
      }
      setParsed(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function onFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      setText(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.readAsText(file);
  }

  const validCount = parsed.filter((r) => r.errors.length === 0).length;
  const invalidCount = parsed.length - validCount;

  return (
    <Modal onClose={onClose} title="Import users from CSV">
      {!result ? (
        <div className="space-y-3">
          <p className="text-xs text-slate-600">
            CSV with header row. Required columns: <code>username</code>,{' '}
            <code>displayName</code>, <code>initialPassword</code>. Optional: <code>email</code>
            , <code>isAdmin</code> (1/true/yes = admin).
          </p>
          <pre className="text-[10px] bg-slate-50 border border-slate-200 rounded p-2 overflow-x-auto">
{`username,displayName,email,initialPassword,isAdmin
alice.smith,Alice Smith,alice@firm.com,initial-pw-change-me-1234,false
bob.jones,Bob Jones,bob@firm.com,initial-pw-change-me-5678,false`}
          </pre>
          <label className="block">
            <span className="text-sm text-slate-700">Paste CSV or load a file</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              className="input font-mono text-xs"
              placeholder="username,displayName,initialPassword&#10;…"
            />
          </label>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
            className="text-xs"
          />
          {error && <div className="text-sm text-rose-600">{error}</div>}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onParse} className="btn-ghost">
              Parse
            </button>
            {parsed.length > 0 && (
              <span className="text-xs text-slate-600">
                {validCount} valid · {invalidCount > 0 && (
                  <span className="text-rose-600">{invalidCount} with errors</span>
                )}
              </span>
            )}
          </div>
          {parsed.length > 0 && (
            <div className="max-h-48 overflow-y-auto border border-slate-200 rounded">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 sticky top-0">
                  <tr>
                    <th className="p-1 text-left">Line</th>
                    <th className="p-1 text-left">Username</th>
                    <th className="p-1 text-left">Display</th>
                    <th className="p-1 text-left">Email</th>
                    <th className="p-1 text-center">Admin</th>
                    <th className="p-1 text-left">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.map((r) => (
                    <tr
                      key={r.line}
                      className={clsx(
                        'border-t border-slate-100',
                        r.errors.length > 0 && 'bg-rose-50',
                      )}
                    >
                      <td className="p-1 text-slate-400">{r.line}</td>
                      <td className="p-1 font-mono">{r.username}</td>
                      <td className="p-1">{r.displayName}</td>
                      <td className="p-1 text-slate-500">{r.email || '—'}</td>
                      <td className="p-1 text-center">{r.isAdmin ? '✔' : ''}</td>
                      <td className="p-1 text-rose-700">{r.errors.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-slate-500">
            Users get the <em>initialPassword</em> from the CSV — tell each user to change
            it on first login. Existing usernames are skipped (not overwritten).
          </p>
          <ModalFooter>
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
            <button
              type="submit"
              onClick={() => {
                const valid = parsed.filter((r) => r.errors.length === 0);
                if (valid.length === 0) {
                  setError('No valid rows to import.');
                  return;
                }
                mut.mutate(valid);
              }}
              disabled={validCount === 0 || mut.isPending}
              className="btn-primary"
            >
              {mut.isPending ? 'Importing…' : `Import ${validCount} user${validCount === 1 ? '' : 's'}`}
            </button>
          </ModalFooter>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="bg-emerald-50 border border-emerald-200 rounded p-2">
            Created <strong>{result.created.length}</strong> user
            {result.created.length === 1 ? '' : 's'}.
          </div>
          {result.skipped.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded p-2 space-y-1">
              <div>Skipped {result.skipped.length}:</div>
              <ul className="text-xs list-disc pl-5">
                {result.skipped.map((s) => (
                  <li key={s.username}>
                    <span className="font-mono">{s.username}</span> — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ModalFooter>
            <button type="button" onClick={onClose} className="btn-primary">
              Done
            </button>
          </ModalFooter>
        </div>
      )}
    </Modal>
  );
}

/**
 * Minimal RFC-4180-ish CSV parser. Handles quoted fields with escaped quotes (`""`),
 * CRLF or LF line endings, and empty trailing fields. Good enough for admin imports;
 * a production-grade exporter will dump compliant output.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------- Provider credentials (Twilio / TextLink / Postmark / SMTP) ----------

interface ProviderSecretMeta {
  key: string;
  configured: boolean;
  last4: string | null;
  updatedAt: string | null;
  updatedByUserId: string | null;
  masked: boolean;
}

// Registry display metadata — matches the server's PROVIDER_SECRET_KEYS list
// but adds user-facing labels and input affordances. Kept hardcoded client-side
// so we control copy + don't have to round-trip "what's this field for" strings.
const PROVIDER_GROUPS: {
  title: string;
  blurb: string;
  keys: {
    key: string;
    label: string;
    placeholder: string;
    inputType?: 'password' | 'text';
  }[];
}[] = [
  {
    title: 'Email — Postmark',
    blurb: 'Used when EMAIL_PROVIDER=postmark. Transactional email for client invites + notifications.',
    keys: [
      {
        key: 'email.postmark.server_token',
        label: 'Server token',
        placeholder: 'Postmark server token',
      },
      {
        key: 'email.postmark.inbound_webhook_secret',
        label: 'Inbound webhook secret',
        placeholder: 'shared secret for Postmark inbound webhooks',
      },
    ],
  },
  {
    title: 'Email — SMTP (Postfix compatible)',
    blurb:
      'Used when EMAIL_PROVIDER=postfix. Direct SMTP (self-hosted relay or third-party).',
    keys: [
      { key: 'email.smtp.host', label: 'Host', placeholder: 'smtp.example.com', inputType: 'text' },
      { key: 'email.smtp.port', label: 'Port', placeholder: '587', inputType: 'text' },
      { key: 'email.smtp.user', label: 'Username', placeholder: 'smtp-user', inputType: 'text' },
      { key: 'email.smtp.pass', label: 'Password', placeholder: 'smtp password' },
      {
        key: 'email.smtp.secure',
        label: 'TLS (1 = on, 0 = off)',
        placeholder: '1',
        inputType: 'text',
      },
    ],
  },
  {
    title: 'SMS — Twilio',
    blurb:
      'Used when SMS_PROVIDER=twilio. Either MessagingServiceSid or From number is required — not both.',
    keys: [
      {
        key: 'sms.twilio.account_sid',
        label: 'Account SID',
        placeholder: 'AC…',
        inputType: 'text',
      },
      { key: 'sms.twilio.auth_token', label: 'Auth token', placeholder: 'Twilio auth token' },
      {
        key: 'sms.twilio.from_number',
        label: 'From number (E.164)',
        placeholder: '+15551234567',
        inputType: 'text',
      },
      {
        key: 'sms.twilio.messaging_service_sid',
        label: 'Messaging service SID',
        placeholder: 'MG…',
        inputType: 'text',
      },
    ],
  },
  {
    title: 'SMS — TextLink',
    blurb: 'Used when SMS_PROVIDER=textlink.',
    keys: [
      { key: 'sms.textlink.api_key', label: 'API key', placeholder: 'TextLink API key' },
      {
        key: 'sms.textlink.webhook_secret',
        label: 'Webhook secret',
        placeholder: 'shared secret for TextLink inbound webhooks',
      },
    ],
  },
];

function AdminProviders(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'providers'],
    queryFn: () => api.listProviderSecrets(),
  });
  const items = q.data?.items ?? [];
  const byKey = new Map(items.map((i) => [i.key, i]));
  const [error, setError] = useState<string | null>(null);

  const setMut = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      api.setProviderSecret(key, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'providers'] }),
    onError: (e: Error) => setError(e.message),
  });
  const clearMut = useMutation({
    mutationFn: (key: string) => api.clearProviderSecret(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'providers'] }),
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="p-4 max-w-3xl">
      <h2 className="font-semibold text-slate-900 mb-1">Provider credentials</h2>
      <p className="text-xs text-slate-600 mb-4">
        API keys + SMTP credentials for the outbound SMS and email bridges. Values are
        encrypted at rest (XSalsa20-Poly1305, key derived from <code>SESSION_SECRET</code>)
        and never shown after they&apos;re saved — rotating a value replaces it. If you
        haven&apos;t set a value here, the bridge falls back to the matching env var. Every
        save and clear writes an audit row.
      </p>
      {error && (
        <div className="mb-4 text-sm rounded-md border border-rose-200 bg-rose-50 text-rose-800 px-3 py-2">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-3 text-rose-600 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}
      {q.isLoading && <div className="text-sm text-slate-500">Loading…</div>}
      <div className="space-y-6">
        {PROVIDER_GROUPS.map((group) => (
          <section key={group.title} className="bg-white rounded-lg shadow-card">
            <header className="px-4 py-3 border-b border-slate-100">
              <h3 className="text-sm font-semibold text-slate-900">{group.title}</h3>
              <p className="text-xs text-slate-500 mt-0.5">{group.blurb}</p>
            </header>
            <div className="divide-y divide-slate-100">
              {group.keys.map((k) => {
                const meta = byKey.get(k.key);
                return (
                  <ProviderSecretRow
                    key={k.key}
                    registry={k}
                    meta={meta}
                    onSave={(value) => {
                      setError(null);
                      setMut.mutate({ key: k.key, value });
                    }}
                    onClear={() => {
                      setError(null);
                      if (confirm(`Clear "${k.label}"? The bridge will fall back to the env var if set.`))
                        clearMut.mutate(k.key);
                    }}
                    pending={setMut.isPending || clearMut.isPending}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ProviderSecretRow({
  registry,
  meta,
  onSave,
  onClear,
  pending,
}: {
  registry: {
    key: string;
    label: string;
    placeholder: string;
    inputType?: 'password' | 'text';
  };
  meta: ProviderSecretMeta | undefined;
  onSave: (value: string) => void;
  onClear: () => void;
  pending: boolean;
}): JSX.Element {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const inputType = registry.inputType ?? 'password';
  const configured = meta?.configured === true;

  // Collapsed state when configured: show last4 / updatedAt + Rotate button.
  // Expanded state: show input + Save/Cancel.
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-800">{registry.label}</div>
          {configured && !editing && (
            <div className="text-[11px] text-slate-500 mt-0.5">
              {meta?.masked
                ? `Configured · ends in ${meta?.last4 ?? '····'}`
                : 'Configured'}
              {meta?.updatedAt && (
                <>
                  {' · '}
                  updated {new Date(meta.updatedAt).toLocaleString()}
                </>
              )}
            </div>
          )}
          {!configured && !editing && (
            <div className="text-[11px] text-slate-500 mt-0.5">
              Not set — bridge will fall back to the env var if present.
            </div>
          )}
          {editing && (
            <form
              className="mt-2 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!value.trim()) return;
                onSave(value);
                setValue('');
                setEditing(false);
              }}
            >
              <input
                autoFocus
                type={inputType}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={registry.placeholder}
                autoComplete="off"
                spellCheck={false}
                className="flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm font-mono focus:border-brand-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!value.trim() || pending}
                className="rounded-md bg-brand-600 text-white text-xs font-medium px-3 py-1 hover:bg-brand-700 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setValue('');
                }}
                className="rounded-md border border-slate-300 text-slate-700 text-xs px-3 py-1 hover:bg-slate-50"
              >
                Cancel
              </button>
            </form>
          )}
        </div>
        {!editing && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs font-medium text-brand-700 hover:underline"
            >
              {configured ? 'Rotate' : 'Set'}
            </button>
            {configured && (
              <button
                type="button"
                onClick={onClear}
                disabled={pending}
                className="text-xs text-rose-700 hover:underline disabled:opacity-50"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- TLS / Let's Encrypt ----------

function AdminTls(): JSX.Element {
  const qc = useQueryClient();
  const settingsQ = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () =>
      json<{
        settings: {
          tls_staff_domain: string | null;
          tls_portal_domain: string | null;
          tls_acme_email: string | null;
          tls_acme_environment: 'staging' | 'production';
          tls_challenge_type: 'http-01' | 'dns-01';
        };
      }>('/admin/settings'),
  });
  // Poll the status endpoint every 2s while an order is in flight so the UI
  // transitions requesting → active (or → error) without a manual refresh.
  const [pollInterval, setPollInterval] = useState(2_000);
  const statusQ = useQuery({
    queryKey: ['admin', 'tls', 'status'],
    queryFn: () => api.getTlsStatus(),
    refetchInterval: pollInterval,
  });
  useEffect(() => {
    // Fast poll only while work is outstanding; otherwise back off to 30s
    // so the cert-expiry clock ticks but we don't burn a request every
    // 2 seconds on an idle appliance.
    setPollInterval(statusQ.data?.inFlight ? 2_000 : 30_000);
  }, [statusQ.data?.inFlight]);

  const settingsMut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      json('/admin/settings', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'tls', 'status'] });
    },
  });

  const [error, setError] = useState<string | null>(null);
  const requestMut = useMutation({
    mutationFn: () => api.requestTls(),
    onError: (e: Error) => setError(e.message),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['admin', 'tls', 'status'] }),
  });
  const renewMut = useMutation({
    mutationFn: () => api.renewTls(),
    onError: (e: Error) => setError(e.message),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['admin', 'tls', 'status'] }),
  });
  const clearMut = useMutation({
    mutationFn: () => api.clearTls(),
    onError: (e: Error) => setError(e.message),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tls', 'status'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
  });

  if (!settingsQ.data || !statusQ.data) {
    return <div className="p-4 text-sm text-slate-500">Loading…</div>;
  }
  const settings = settingsQ.data.settings;
  const status = statusQ.data;
  const cert = status.cert;
  const isActive = Boolean(cert && cert.daysUntilExpiry > 0);
  const canRequest = Boolean(settings.tls_staff_domain && settings.tls_acme_email);
  // Distribution mode: when an upstream Caddy / Cloudflare Tunnel terminates
  // TLS, the in-app ACME ticker is off and the request/renew/clear endpoints
  // 409. Show a notice instead of a half-functional renewal panel.
  const tlsExternal = status.tlsMode === 'external';

  if (tlsExternal) {
    return (
      <div className="p-4 max-w-3xl space-y-5">
        <header>
          <h2 className="font-semibold text-slate-900">TLS</h2>
        </header>
        <div className="rounded-md border border-slate-200 bg-slate-50 text-slate-700 text-sm px-4 py-3 leading-relaxed">
          <p>
            <strong>TLS managed externally.</strong> This appliance is configured
            with <code className="text-xs bg-white px-1 rounded">TLS_MODE=external</code>
            , meaning an upstream reverse proxy (Caddy in the Vibe installer&apos;s
            multi-app mode, or Cloudflare Tunnel) terminates TLS before traffic
            reaches the appliance.
          </p>
          <p className="mt-2 text-xs text-slate-500">
            The in-app Let&apos;s Encrypt renewal job is disabled in this mode.
            To re-enable in-app TLS, restart the appliance with{' '}
            <code className="bg-white px-1 rounded">TLS_MODE=internal</code> and a
            staff domain configured.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-3xl space-y-5">
      <header>
        <h2 className="font-semibold text-slate-900">TLS / Let&apos;s Encrypt</h2>
        <p className="text-xs text-slate-600 mt-1">
          Issue + auto-renew certs for the staff site and client portal. Requires the
          appliance to be reachable at each domain on port 80 (HTTP-01 challenge) and
          DNS A records pointing at the appliance&apos;s public IP. A daily background
          job renews any cert within 30 days of expiry.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 text-rose-800 text-xs px-3 py-2">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-3 text-rose-600 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}
      {settings.tls_acme_environment === 'production' && (
        <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-900 text-xs px-3 py-2">
          <strong>Production mode.</strong> Let&apos;s Encrypt enforces strict rate
          limits (50 certs / domain / week, 5 failed validations / hour). Test in
          Staging first whenever the DNS or firewall config changes.
        </div>
      )}

      {/* Section 1 — Configuration */}
      <section className="bg-white rounded-lg shadow-card p-4 space-y-3">
        <h3 className="text-sm font-semibold text-slate-900">Domains &amp; contact</h3>
        <label className="block">
          <span className="text-xs text-slate-600">Staff site domain</span>
          <input
            type="text"
            defaultValue={settings.tls_staff_domain ?? ''}
            onBlur={(e) =>
              settingsMut.mutate({ tlsStaffDomain: e.target.value.trim() || null })
            }
            placeholder="connect.example.com"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs text-slate-600">
            Client portal domain <span className="text-slate-400">(optional; omit to reuse the staff cert)</span>
          </span>
          <input
            type="text"
            defaultValue={settings.tls_portal_domain ?? ''}
            onBlur={(e) =>
              settingsMut.mutate({ tlsPortalDomain: e.target.value.trim() || null })
            }
            placeholder="portal.example.com"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs text-slate-600">ACME account email</span>
          <input
            type="email"
            defaultValue={settings.tls_acme_email ?? ''}
            onBlur={(e) =>
              settingsMut.mutate({ tlsAcmeEmail: e.target.value.trim() || null })
            }
            placeholder="ops@example.com"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <span className="mt-1 text-[11px] text-slate-500 block">
            Let&apos;s Encrypt sends renewal + expiry warnings to this address.
          </span>
        </label>
        <label className="block">
          <span className="text-xs text-slate-600">Environment</span>
          <select
            defaultValue={settings.tls_acme_environment}
            onChange={(e) =>
              settingsMut.mutate({
                tlsAcmeEnvironment: e.target.value as 'staging' | 'production',
              })
            }
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="staging">Staging (untrusted, for testing)</option>
            <option value="production">Production (browser-trusted)</option>
          </select>
        </label>
      </section>

      {/* Section 2 — Challenge method */}
      <section className="bg-white rounded-lg shadow-card p-4 space-y-3">
        <h3 className="text-sm font-semibold text-slate-900">Challenge method</h3>
        <div
          role="radiogroup"
          aria-label="ACME challenge method"
          className="grid grid-cols-2 gap-1 bg-slate-100 rounded-md p-1 max-w-sm"
        >
          <div className="bg-white rounded border border-slate-200 text-xs py-1.5 text-center font-medium text-slate-900 shadow-sm">
            HTTP-01
          </div>
          <div
            className="text-xs py-1.5 text-center text-slate-400 cursor-not-allowed"
            title="DNS-01 ships in Phase 2"
          >
            DNS-01 (coming soon)
          </div>
        </div>
        <p className="text-[11px] text-slate-500">
          HTTP-01 requires port 80 on the appliance reachable from Let&apos;s Encrypt.
          Use DNS-01 for LAN-only installs or wildcard certs (Phase 2).
        </p>
      </section>

      {/* Section 3 — Certificate status */}
      <section className="bg-white rounded-lg shadow-card p-4 space-y-3">
        <h3 className="text-sm font-semibold text-slate-900">Current certificate</h3>
        {status.inFlight && (
          <div className="rounded-md border border-brand-200 bg-brand-50 text-brand-900 text-xs px-3 py-2 flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-brand-600 animate-pulse" />
            Requesting certificate from Let&apos;s Encrypt — this can take up to 60
            seconds while HTTP-01 validation runs.
          </div>
        )}
        {!cert && !status.inFlight && (
          <p className="text-xs text-slate-500">
            No certificate issued yet. Fill in the fields above, then click
            <strong> Request certificate</strong>.
          </p>
        )}
        {cert && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-slate-500">Subject</dt>
            <dd className="font-mono text-slate-800 truncate">{cert.subject}</dd>
            <dt className="text-slate-500">Issuer</dt>
            <dd className="font-mono text-slate-800 truncate">{cert.issuer}</dd>
            <dt className="text-slate-500">Hostnames</dt>
            <dd className="font-mono text-slate-800 truncate">
              {cert.hostnames.join(', ') || '—'}
            </dd>
            <dt className="text-slate-500">Expires</dt>
            <dd className="text-slate-800">
              {new Date(cert.expiresAt).toLocaleString()}{' '}
              <span
                className={
                  cert.daysUntilExpiry < 0
                    ? 'text-rose-700 font-medium'
                    : cert.daysUntilExpiry < 30
                      ? 'text-amber-700 font-medium'
                      : 'text-emerald-700 font-medium'
                }
              >
                (
                {cert.daysUntilExpiry < 0
                  ? `expired ${Math.abs(cert.daysUntilExpiry)}d ago`
                  : `${cert.daysUntilExpiry}d left`}
                )
              </span>
            </dd>
          </dl>
        )}
        {status.lastError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 text-rose-800 text-xs px-3 py-2 font-mono whitespace-pre-wrap break-words">
            {status.lastError}
          </div>
        )}
      </section>

      {/* Section 4 — Actions */}
      <section className="bg-white rounded-lg shadow-card p-4 space-y-3">
        <h3 className="text-sm font-semibold text-slate-900">Actions</h3>
        <div className="flex flex-wrap items-center gap-2">
          {!isActive ? (
            <button
              type="button"
              disabled={!canRequest || status.inFlight || requestMut.isPending}
              onClick={() => {
                setError(null);
                requestMut.mutate();
              }}
              className="rounded-md bg-brand-600 text-white text-sm font-medium px-3 py-1.5 hover:bg-brand-700 disabled:opacity-50"
              title={
                canRequest
                  ? 'Issue a new certificate from Let’s Encrypt'
                  : 'Save a staff domain + ACME email first'
              }
            >
              {status.inFlight ? 'Requesting…' : 'Request certificate'}
            </button>
          ) : (
            <button
              type="button"
              disabled={status.inFlight || renewMut.isPending}
              onClick={() => {
                setError(null);
                renewMut.mutate();
              }}
              className="rounded-md bg-brand-600 text-white text-sm font-medium px-3 py-1.5 hover:bg-brand-700 disabled:opacity-50"
            >
              {status.inFlight ? 'Renewing…' : 'Renew now'}
            </button>
          )}
          {(isActive || status.config.accountKeyConfigured) && (
            <button
              type="button"
              disabled={status.inFlight || clearMut.isPending}
              onClick={() => {
                setError(null);
                if (
                  confirm(
                    'Revoke the current cert and wipe its files + metadata? ' +
                      'Nginx will fall back to the self-signed bootstrap certs on next reload.',
                  )
                ) {
                  clearMut.mutate();
                }
              }}
              className="rounded-md border border-rose-300 text-rose-700 text-sm px-3 py-1.5 hover:bg-rose-50 disabled:opacity-50"
            >
              Revoke &amp; clear
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

// =================================================================
// Phase 24.6 — Request templates CRUD
// =================================================================

interface TemplateItemSpec {
  title: string;
  description?: string | null;
  responseType: 'file' | 'text' | 'both';
  sortOrder: number;
  defaultDueOffsetDays?: number | null;
}

function blankSpec(sortOrder = 0): TemplateItemSpec {
  return { title: '', description: '', responseType: 'both', sortOrder };
}

function AdminRequestTemplates(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'request-templates'],
    queryFn: () => api.requests.listTemplates().then((r) => r.templates),
    staleTime: 15_000,
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const archiveMut = useMutation({
    mutationFn: (id: string) => api.requests.archiveTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'request-templates'] }),
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="p-4 max-w-4xl">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-semibold text-slate-900">Request templates</h2>
          <p className="text-xs text-slate-500">
            Reusable checklists. Applied to a conversation, items are encrypted under
            that conversation&apos;s content key — the template itself stays cleartext.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditingId(null);
            setCreating(true);
          }}
          className="text-sm rounded-md bg-brand-600 text-white px-3 py-1.5 hover:bg-brand-700"
        >
          + New template
        </button>
      </div>

      {error && (
        <div className="mb-3 text-xs rounded-md border border-rose-200 bg-rose-50 text-rose-800 px-3 py-2 flex justify-between gap-2">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {(creating || editingId) && (
        <TemplateEditor
          templateId={editingId}
          onClose={() => {
            setEditingId(null);
            setCreating(false);
          }}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ['admin', 'request-templates'] });
            setEditingId(null);
            setCreating(false);
          }}
        />
      )}

      <div className="bg-white rounded shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase text-slate-500 tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">Name</th>
              <th className="text-left px-3 py-2">Items</th>
              <th className="text-left px-3 py-2">Updated</th>
              <th className="text-right px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {q.isLoading && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-slate-500 text-xs">
                  Loading…
                </td>
              </tr>
            )}
            {!q.isLoading && (q.data ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-slate-500 text-xs">
                  No templates yet.
                </td>
              </tr>
            )}
            {(q.data ?? []).map((t) => (
              <tr key={t.id} className="hover:bg-slate-50">
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-900">{t.name}</div>
                  {t.description && (
                    <div className="text-[11px] text-slate-500 max-w-[280px] truncate">
                      {t.description}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {t.itemSpecs.length} item{t.itemSpecs.length === 1 ? '' : 's'}
                </td>
                <td className="px-3 py-2 text-[11px] text-slate-500">
                  {new Date(t.updatedAt).toLocaleDateString()}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setEditingId(t.id);
                    }}
                    className="text-[11px] text-brand-700 hover:underline mr-2"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        confirm(
                          `Archive template "${t.name}"? Existing lists already created from it are unaffected.`,
                        )
                      ) {
                        archiveMut.mutate(t.id);
                      }
                    }}
                    className="text-[11px] text-rose-700 hover:underline"
                  >
                    Archive
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TemplateEditor({
  templateId,
  onClose,
  onSaved,
}: {
  templateId: string | null;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<TemplateItemSpec[]>([blankSpec(0)]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // For edit mode: hydrate from the existing template once.
  const existingQ = useQuery({
    queryKey: ['admin', 'request-template', templateId],
    queryFn: () =>
      templateId
        ? api.requests.listTemplates().then((r) => r.templates.find((t) => t.id === templateId))
        : Promise.resolve(null),
    enabled: Boolean(templateId),
  });
  useEffect(() => {
    if (!templateId) return;
    if (!existingQ.data) return;
    setName(existingQ.data.name);
    setDescription(existingQ.data.description ?? '');
    setItems(
      existingQ.data.itemSpecs.length > 0
        ? existingQ.data.itemSpecs.map((s, i) => ({ ...s, sortOrder: i }))
        : [blankSpec(0)],
    );
  }, [templateId, existingQ.data]);

  async function save(): Promise<void> {
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    const cleanItems = items
      .filter((i) => i.title.trim().length > 0)
      .map((i, idx) => ({
        title: i.title.trim(),
        description: i.description?.trim() || null,
        responseType: i.responseType,
        sortOrder: idx,
        defaultDueOffsetDays:
          i.defaultDueOffsetDays !== undefined && i.defaultDueOffsetDays !== null
            ? Number(i.defaultDueOffsetDays)
            : undefined,
      }));
    if (cleanItems.length === 0) {
      setError('Add at least one item.');
      return;
    }
    setSaving(true);
    try {
      if (templateId) {
        await api.requests.patchTemplate(templateId, {
          name: name.trim(),
          description: description.trim() || null,
          itemSpecs: cleanItems,
        });
      } else {
        await api.requests.createTemplate({
          name: name.trim(),
          description: description.trim() || null,
          itemSpecs: cleanItems,
        });
      }
      qc.invalidateQueries({ queryKey: ['admin', 'request-templates'] });
      onSaved();
    } catch (err) {
      const e = err as { status?: number; body?: string };
      if (e.status === 409) {
        setError('A template with that name already exists.');
      } else {
        setError(err instanceof Error ? err.message : 'Save failed');
      }
    } finally {
      setSaving(false);
    }
  }

  function moveItem(from: number, dir: -1 | 1): void {
    setItems((prev) => {
      const next = [...prev];
      const target = from + dir;
      if (target < 0 || target >= next.length) return prev;
      const tmp = next[from]!;
      next[from] = next[target]!;
      next[target] = tmp;
      return next.map((s, i) => ({ ...s, sortOrder: i }));
    });
  }

  return (
    <div className="bg-white rounded shadow-card border border-slate-200 mb-3">
      <header className="px-4 py-2 border-b border-slate-200 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-900">
          {templateId ? 'Edit template' : 'New template'}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-slate-500 hover:text-slate-800 px-2 py-0.5"
        >
          ×
        </button>
      </header>
      <div className="px-4 py-3 space-y-3">
        <label className="block">
          <span className="text-[11px] text-slate-600">Name</span>
          <input
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            placeholder="Year-end tax documents"
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-600">Description</span>
          <textarea
            value={description}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <div>
          <div className="text-[11px] text-slate-600 mb-1">Items</div>
          <ul className="space-y-2">
            {items.map((it, idx) => (
              <li
                key={idx}
                className="rounded-md border border-slate-200 p-2 space-y-1.5 bg-slate-50/50"
              >
                <div className="flex items-center gap-2">
                  <input
                    value={it.title}
                    onChange={(e) =>
                      setItems((prev) =>
                        prev.map((p, i) => (i === idx ? { ...p, title: e.target.value } : p)),
                      )
                    }
                    maxLength={200}
                    placeholder="Item title"
                    className="flex-1 rounded border border-slate-300 text-sm px-2 py-1"
                  />
                  <button
                    type="button"
                    onClick={() => moveItem(idx, -1)}
                    disabled={idx === 0}
                    className="text-slate-500 hover:text-slate-800 disabled:opacity-30"
                    aria-label="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveItem(idx, 1)}
                    disabled={idx === items.length - 1}
                    className="text-slate-500 hover:text-slate-800 disabled:opacity-30"
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  {items.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                      className="text-rose-600 hover:underline text-[11px]"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <input
                  value={it.description ?? ''}
                  onChange={(e) =>
                    setItems((prev) =>
                      prev.map((p, i) =>
                        i === idx ? { ...p, description: e.target.value } : p,
                      ),
                    )
                  }
                  maxLength={2000}
                  placeholder="Description (optional)"
                  className="w-full rounded border border-slate-300 text-xs px-2 py-1"
                />
                <div className="flex items-center gap-2 text-xs">
                  <select
                    value={it.responseType}
                    onChange={(e) =>
                      setItems((prev) =>
                        prev.map((p, i) =>
                          i === idx
                            ? {
                                ...p,
                                responseType: e.target.value as
                                  | 'file'
                                  | 'text'
                                  | 'both',
                              }
                            : p,
                        ),
                      )
                    }
                    className="rounded border border-slate-300 px-1.5 py-0.5 bg-white"
                  >
                    <option value="both">File or text</option>
                    <option value="file">File only</option>
                    <option value="text">Text only</option>
                  </select>
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
                    Due offset (days)
                    <input
                      type="number"
                      min={0}
                      max={3650}
                      value={it.defaultDueOffsetDays ?? ''}
                      onChange={(e) =>
                        setItems((prev) =>
                          prev.map((p, i) =>
                            i === idx
                              ? {
                                  ...p,
                                  defaultDueOffsetDays:
                                    e.target.value === ''
                                      ? null
                                      : Number(e.target.value),
                                }
                              : p,
                          ),
                        )
                      }
                      className="w-16 rounded border border-slate-300 px-1.5 py-0.5"
                    />
                  </label>
                </div>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setItems((prev) => [...prev, blankSpec(prev.length)])}
            className="mt-2 text-[11px] text-brand-700 hover:underline"
          >
            + Add item
          </button>
        </div>
        {error && <p className="text-xs text-rose-700">{error}</p>}
      </div>
      <footer className="px-4 py-2 border-t border-slate-200 bg-slate-50/50 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="text-xs rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="text-xs rounded-md bg-brand-600 text-white px-3 py-1 hover:bg-brand-700 disabled:bg-slate-300"
        >
          {saving ? 'Saving…' : templateId ? 'Save changes' : 'Create template'}
        </button>
      </footer>
    </div>
  );
}
