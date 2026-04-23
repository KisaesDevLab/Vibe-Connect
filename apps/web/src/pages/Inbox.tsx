import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import { api } from '../api.js';

export function InboxPage(): JSX.Element {
  const convQ = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.listConversations().then((r) => r.conversations),
  });

  const unread = useMemo(
    () =>
      (convQ.data ?? [])
        .filter((c) => c.unreadCount > 0)
        .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')),
    [convQ.data],
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6">
        <h1 className="text-xl font-semibold text-slate-900 mb-4">Inbox</h1>
        {convQ.isLoading && <div className="text-sm text-slate-500">Loading…</div>}
        {unread.length === 0 && !convQ.isLoading && (
          <div className="text-sm text-slate-500">You&apos;re all caught up.</div>
        )}
        <ul className="divide-y divide-slate-200 bg-white rounded-lg shadow-card">
          {unread.map((c) => (
            <li key={c.id}>
              <NavLink to={`/conversation/${c.id}`} className="block px-4 py-3 hover:bg-slate-50">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-800">{c.displayName ?? '(direct)'}</span>
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
      </div>
    </div>
  );
}

export function QuickSwitcher({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const [q, setQ] = useState('');
  const convQ = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.listConversations().then((r) => r.conversations),
    enabled: open,
  });
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);
  if (!open) return null;
  const list = (convQ.data ?? []).filter(
    (c) => !q || (c.displayName ?? '').toLowerCase().includes(q.toLowerCase()),
  );
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
                {c.displayName ?? '(direct)'}
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
