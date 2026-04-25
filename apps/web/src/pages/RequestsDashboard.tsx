// Phase 24.6 — Bulk dashboard for staff: every active request list across
// every conversation the caller is a member of, sorted by urgency.
//
// Filters land client-side because the result set is bounded by the
// caller's conversation membership (a few hundred lists at most for any
// realistic firm). If that ever stops being true we move to keyset
// pagination + server-side filters.
//
// Item titles are E2EE so the dashboard intentionally renders only the
// CLEARTEXT list-level fields: title, description, due_date, status, plus
// per-status item counts. Drilling into a row deep-links to the
// conversation with the request panel auto-opened, which decrypts item
// titles client-side under the conversation key.
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import type { RequestDashboardRow } from '@vibe-connect/shared-types';
import { api } from '../api.js';
import { useAuth } from '../state/auth.js';

type Filter = 'all' | 'mine' | 'overdue' | 'stale';

interface DueChip {
  label: string;
  className: string;
}

function dueChip(row: RequestDashboardRow): DueChip {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (row.list.status === 'completed') {
    return { label: 'Complete', className: 'bg-emerald-100 text-emerald-800' };
  }
  if (!row.list.dueDate) {
    return { label: 'No due', className: 'bg-slate-100 text-slate-700' };
  }
  const due = new Date(row.list.dueDate + 'T00:00:00');
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) {
    return {
      label: `${Math.abs(diffDays)}d overdue`,
      className: 'bg-rose-100 text-rose-800',
    };
  }
  if (diffDays === 0) return { label: 'Due today', className: 'bg-amber-100 text-amber-900' };
  if (diffDays <= 3) return { label: `Due in ${diffDays}d`, className: 'bg-amber-50 text-amber-800' };
  return { label: `Due ${row.list.dueDate}`, className: 'bg-slate-100 text-slate-700' };
}

function isOverdue(row: RequestDashboardRow): boolean {
  if (row.list.status === 'completed') return false;
  if (!row.list.dueDate) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(row.list.dueDate + 'T00:00:00').getTime() < today.getTime();
}

function isStale(row: RequestDashboardRow): boolean {
  if (row.list.status !== 'active') return false;
  if (!row.lastActivityAt) return true;
  const lastActivity = new Date(row.lastActivityAt).getTime();
  return Date.now() - lastActivity > 3 * 86_400_000;
}

function progressPercent(counts: RequestDashboardRow['itemCounts']): number {
  const total = counts.pending + counts.submitted + counts.done + counts.revision;
  if (total === 0) return 0;
  return Math.round((counts.done / total) * 100);
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

export function RequestsDashboardPage(): JSX.Element {
  const { user } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const policyQ = useQuery({
    queryKey: ['security-policy'],
    queryFn: () => api.getSecurityPolicy(),
    staleTime: 60_000,
  });
  const requestsEnabled = policyQ.data?.requestsEnabled !== false;
  const dashQ = useQuery({
    queryKey: ['request-dashboard'],
    queryFn: () => api.requests.dashboard().then((r) => r.rows),
    staleTime: 15_000,
    enabled: requestsEnabled,
  });
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);

  const markDoneCount = useMutation({
    mutationFn: () => Promise.resolve(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['request-dashboard'] }),
  });
  void markDoneCount; // reserved for future bulk actions

  const filtered = useMemo(() => {
    const all = dashQ.data ?? [];
    switch (filter) {
      case 'mine':
        return all.filter((r) => r.list.createdBy === user?.id);
      case 'overdue':
        return all.filter(isOverdue);
      case 'stale':
        return all.filter(isStale);
      case 'all':
      default:
        return all;
    }
  }, [dashQ.data, filter, user?.id]);

  const totals = useMemo(() => {
    const all = dashQ.data ?? [];
    return {
      total: all.length,
      mine: all.filter((r) => r.list.createdBy === user?.id).length,
      overdue: all.filter(isOverdue).length,
      stale: all.filter(isStale).length,
    };
  }, [dashQ.data, user?.id]);

  if (!requestsEnabled) {
    return (
      <div className="p-4 max-w-6xl mx-auto">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <h2 className="text-base font-semibold mb-1">Requests are disabled</h2>
          <p>
            An admin has turned off the client-requests feature. Existing lists are preserved
            and will reappear when an admin re-enables Requests in{' '}
            <NavLink to="/admin/settings" className="underline font-medium">
              Admin → Settings
            </NavLink>
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Requests</h2>
          <p className="text-xs text-slate-500">
            Every active checklist across your conversations. Click a row to open it.
          </p>
        </div>
      </header>

      {error && (
        <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 text-rose-800 text-xs px-3 py-2 flex justify-between gap-2">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div
        role="tablist"
        aria-label="Filter"
        className="flex items-center gap-1 mb-3 bg-slate-100 rounded-md p-1 w-fit"
      >
        {(
          [
            { id: 'all', label: 'All', count: totals.total },
            { id: 'mine', label: 'Mine', count: totals.mine },
            { id: 'overdue', label: 'Overdue', count: totals.overdue },
            { id: 'stale', label: 'Stale > 3d', count: totals.stale },
          ] as const
        ).map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={clsx(
              'text-xs px-3 py-1 rounded',
              filter === f.id
                ? 'bg-white text-slate-900 font-medium shadow-sm border border-slate-200'
                : 'text-slate-600 hover:text-slate-900',
            )}
          >
            {f.label}
            <span
              className={clsx(
                'ml-1.5 text-[10px] rounded-full px-1.5',
                filter === f.id ? 'bg-slate-100 text-slate-600' : 'bg-slate-200 text-slate-700',
              )}
            >
              {f.count}
            </span>
          </button>
        ))}
      </div>

      <div className="bg-white rounded shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Conversation</th>
              <th className="text-left px-3 py-2">List</th>
              <th className="text-left px-3 py-2 w-[180px]">Progress</th>
              <th className="text-left px-3 py-2">Due</th>
              <th className="text-left px-3 py-2">Last activity</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {dashQ.isLoading && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500 text-xs">
                  Loading…
                </td>
              </tr>
            )}
            {!dashQ.isLoading && filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500 text-xs">
                  Nothing matches this filter.
                </td>
              </tr>
            )}
            {filtered.map((row) => {
              const pct = progressPercent(row.itemCounts);
              const total =
                row.itemCounts.pending +
                row.itemCounts.submitted +
                row.itemCounts.done +
                row.itemCounts.revision;
              const due = dueChip(row);
              const needsReview = row.itemCounts.submitted > 0;
              return (
                <tr
                  key={row.list.id}
                  className="hover:bg-slate-50 cursor-pointer"
                  onClick={() => nav(`/conversation/${row.list.conversationId}`)}
                >
                  <td className="px-3 py-2 truncate max-w-[180px]">
                    {row.conversationDisplayName ?? '(direct)'}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900 truncate max-w-[260px]">
                      {row.list.title}
                    </div>
                    {row.list.description && (
                      <div className="text-[11px] text-slate-500 truncate max-w-[260px]">
                        {row.list.description}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 align-middle">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-slate-100 rounded">
                        <div
                          className="h-1.5 bg-emerald-500 rounded"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-[11px] text-slate-600 whitespace-nowrap">
                        {row.itemCounts.done}/{total}
                      </span>
                    </div>
                    {needsReview && (
                      <div className="mt-1 text-[10px] text-amber-700">
                        {row.itemCounts.submitted} awaiting review
                      </div>
                    )}
                    {row.itemCounts.revision > 0 && (
                      <div className="mt-1 text-[10px] text-rose-700">
                        {row.itemCounts.revision} in revision
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 align-middle">
                    <span
                      className={clsx(
                        'text-[10px] font-medium px-2 py-0.5 rounded',
                        due.className,
                      )}
                    >
                      {due.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 align-middle text-[11px] text-slate-600">
                    {relativeTime(row.lastActivityAt)}
                  </td>
                  <td className="px-3 py-2 align-middle text-right">
                    <NavLink
                      to={`/conversation/${row.list.conversationId}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[11px] text-brand-700 hover:underline whitespace-nowrap"
                    >
                      Open →
                    </NavLink>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
