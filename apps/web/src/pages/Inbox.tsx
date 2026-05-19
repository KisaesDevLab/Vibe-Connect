import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import type { PublicUser } from '@vibe-connect/shared-types';
import { api } from '../api.js';
import { useAuth } from '../state/auth.js';
import { threadLabel } from '../lib/threadLabel.js';

export function InboxPage(): JSX.Element {
  const { user: me } = useAuth();
  const convQ = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.listConversations(),
  });
  const usersQ = useQuery({
    queryKey: ['users'],
    queryFn: () => api.listUsers(),
    staleTime: 30_000,
  });
  const intakesQ = useQuery({
    queryKey: ['inbox', 'intakes'],
    queryFn: () => api.inboxIntakes().then((r) => r.sessions),
    staleTime: 15_000,
  });
  const usersById = useMemo(() => {
    const m: Record<string, PublicUser> = {};
    for (const u of usersQ.data?.users ?? []) m[u.id] = u;
    return m;
  }, [usersQ.data]);

  const unread = useMemo(
    () =>
      (convQ.data?.conversations ?? [])
        .filter((c) => c.unreadCount > 0)
        .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')),
    [convQ.data],
  );

  const intakes = intakesQ.data ?? [];

  const totalNew = unread.length + intakes.length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <h1 className="text-xl font-semibold text-slate-900">Inbox</h1>

        {/* Intake submissions — surfaced until staff opens the detail
            view (which fires the mark-read API and drops the row). */}
        {intakes.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
              <span>New intake submissions</span>
              <span className="text-xs font-semibold bg-amber-500 text-white rounded-full px-2 py-0.5">
                {intakes.length}
              </span>
            </h2>
            <ul className="divide-y divide-slate-200 bg-white rounded-lg shadow-card">
              {intakes.map((s) => (
                <li key={s.id}>
                  <NavLink
                    to={`/admin/intake?session=${s.id}`}
                    className="block px-4 py-3 hover:bg-slate-50"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-800">
                        {s.clientName?.trim() || '(name not provided)'}
                      </span>
                      <span className="text-xs text-slate-500">
                        {s.fileCount} file{s.fileCount === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      To {s.staffDisplayName ?? 'staff'} ·{' '}
                      {new Date(s.finalizedAt ?? s.createdAt).toLocaleString()}
                      {s.status !== 'finalized' && s.status !== 'open' && (
                        <span className="ml-2 text-amber-700">({s.status})</span>
                      )}
                    </div>
                  </NavLink>
                </li>
              ))}
            </ul>
          </section>
        )}

        <RequestsAttentionWidget />

        <section>
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Unread conversations</h2>
          {convQ.isLoading && <div className="text-sm text-slate-500">Loading…</div>}
          {unread.length === 0 && !convQ.isLoading && totalNew === 0 && (
            <div className="text-sm text-slate-500">You&apos;re all caught up.</div>
          )}
          {unread.length > 0 && (
            <ul className="divide-y divide-slate-200 bg-white rounded-lg shadow-card">
              {unread.map((c) => (
                <li key={c.id}>
                  <NavLink
                    to={`/conversation/${c.id}`}
                    className="block px-4 py-3 hover:bg-slate-50"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-800">
                        {threadLabel(c, usersById, me?.id ?? null)}
                      </span>
                      <span className="text-xs font-semibold bg-brand-600 text-white rounded-full px-2 py-0.5">
                        {c.unreadCount > 99 ? '99+' : c.unreadCount}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      {c.lastMessageAt
                        ? new Date(c.lastMessageAt).toLocaleString()
                        : 'No recent activity'}
                    </div>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Phase 24.8 — "Attention needed" widget for the Inbox home. Counts active
 * lists with overdue dates plus items currently in `submitted` (waiting for
 * staff review). Hidden when nothing's open. Click-through deep-links to
 * the bulk Requests dashboard with the relevant filter pre-applied via the
 * existing `/requests` route — that page handles its own filter state, so
 * we just send the staff there and let them pivot.
 */
function RequestsAttentionWidget(): JSX.Element | null {
  const policyQ = useQuery({
    queryKey: ['security-policy'],
    queryFn: () => api.getSecurityPolicy(),
    staleTime: 60_000,
  });
  const requestsEnabled = policyQ.data?.requestsEnabled !== false;
  const dashQ = useQuery({
    queryKey: ['request-dashboard'],
    queryFn: () => api.requests.dashboard().then((r) => r.rows),
    staleTime: 30_000,
    enabled: requestsEnabled,
  });
  const stats = useMemo(() => {
    const rows = dashQ.data ?? [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let overdueLists = 0;
    let needsReview = 0;
    for (const r of rows) {
      if (r.list.status === 'active' && r.list.dueDate) {
        const due = new Date(r.list.dueDate + 'T00:00:00');
        if (due.getTime() < today.getTime()) overdueLists++;
      }
      needsReview += r.itemCounts.submitted;
    }
    return { overdueLists, needsReview };
  }, [dashQ.data]);
  if (!requestsEnabled) return null;
  if (dashQ.isLoading) return null;
  if (stats.overdueLists === 0 && stats.needsReview === 0) return null;
  return (
    <NavLink
      to="/requests"
      className="block mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 hover:bg-amber-100"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-amber-900">Attention needed</div>
          <div className="text-xs text-amber-800 mt-0.5">
            {stats.overdueLists > 0 && (
              <span>
                <strong>{stats.overdueLists}</strong> list
                {stats.overdueLists === 1 ? '' : 's'} overdue
              </span>
            )}
            {stats.overdueLists > 0 && stats.needsReview > 0 && <span> · </span>}
            {stats.needsReview > 0 && (
              <span>
                <strong>{stats.needsReview}</strong> item
                {stats.needsReview === 1 ? '' : 's'} awaiting review
              </span>
            )}
          </div>
        </div>
        <span className="text-xs text-amber-900 font-medium whitespace-nowrap">
          Open dashboard →
        </span>
      </div>
    </NavLink>
  );
}

export function QuickSwitcher({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const { user: me } = useAuth();
  const [q, setQ] = useState('');
  const convQ = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.listConversations(),
    enabled: open,
  });
  const usersQ = useQuery({
    queryKey: ['users'],
    queryFn: () => api.listUsers(),
    staleTime: 30_000,
    enabled: open,
  });
  const usersById = useMemo(() => {
    const m: Record<string, PublicUser> = {};
    for (const u of usersQ.data?.users ?? []) m[u.id] = u;
    return m;
  }, [usersQ.data]);
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);
  if (!open) return null;
  const qLower = q.toLowerCase();
  const list = (convQ.data?.conversations ?? []).filter((c) => {
    if (!q) return true;
    // Match against the resolved label so ad-hoc "Alice, Bob, Carol" threads
    // surface on typing a member name, not only on the missing displayName.
    return threadLabel(c, usersById, me?.id ?? null)
      .toLowerCase()
      .includes(qLower);
  });
  return (
    <div className="fixed inset-0 bg-slate-900/30 z-50 grid place-items-start pt-24">
      <div className="bg-white w-full max-w-lg mx-auto rounded-lg shadow-popover overflow-hidden">
        <input
          autoFocus
          type="text"
          placeholder="Jump to conversation…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full px-4 py-3 text-sm border-b border-slate-200 focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
        />
        <ul className="max-h-80 overflow-y-auto">
          {list.slice(0, 20).map((c) => (
            <li key={c.id}>
              <NavLink
                to={`/conversation/${c.id}`}
                onClick={onClose}
                className="block px-4 py-2 text-sm hover:bg-slate-100"
              >
                {threadLabel(c, usersById, me?.id ?? null)}
                <span className="ml-2 text-xs text-slate-400">
                  {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : ''}
                </span>
              </NavLink>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function SearchModal({
  open,
  onClose,
  search,
}: {
  open: boolean;
  onClose: () => void;
  search: (
    q: string,
  ) => Array<{ id: string; conversationId: string; body: string; createdAt: string }>;
}): JSX.Element | null {
  const [q, setQ] = useState('');
  if (!open) return null;
  const hits = q ? search(q) : [];
  return (
    <div className="fixed inset-0 bg-slate-900/30 z-50 grid place-items-start pt-24">
      <div className="bg-white w-full max-w-xl mx-auto rounded-lg shadow-popover overflow-hidden">
        <input
          autoFocus
          type="search"
          placeholder="Search your messages"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full px-4 py-3 text-sm border-b border-slate-200 focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
        />
        <ul className="max-h-96 overflow-y-auto">
          {hits.map((h) => (
            <li key={h.id}>
              <NavLink
                to={`/conversation/${h.conversationId}#msg-${h.id}`}
                onClick={onClose}
                className="block px-4 py-2 text-sm hover:bg-slate-100"
              >
                <div className="truncate">{h.body}</div>
                <div className="text-xs text-slate-400">
                  {new Date(h.createdAt).toLocaleString()}
                </div>
              </NavLink>
            </li>
          ))}
          {q && hits.length === 0 && (
            <li className="px-4 py-3 text-sm text-slate-500">No matches.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
