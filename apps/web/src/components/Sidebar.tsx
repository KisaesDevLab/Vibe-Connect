import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import type { ConversationSummary, Group, PublicUser } from '@vibe-connect/shared-types';
import { api } from '../api.js';
import { useAuth } from '../state/auth.js';
import { useCrypto } from '../state/crypto.js';

function UserRow({
  user,
  unread,
  selected,
  onToggle,
  multiSelect,
}: {
  user: PublicUser;
  unread: number;
  selected: boolean;
  onToggle: () => void;
  multiSelect: boolean;
}) {
  const dotColor =
    user.status === 'active'
      ? 'bg-emerald-500'
      : user.status === 'away'
        ? 'bg-amber-400'
        : user.status === 'dnd'
          ? 'bg-rose-500'
          : 'bg-slate-300';
  return (
    <button
      type="button"
      onClick={onToggle}
      className={clsx(
        'w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100',
        selected && 'bg-brand-50',
      )}
    >
      {multiSelect && (
        <input
          type="checkbox"
          checked={selected}
          readOnly
          className="accent-brand-600"
          tabIndex={-1}
        />
      )}
      <div className="relative w-8 h-8 rounded-full bg-slate-200 grid place-items-center text-slate-700 text-xs font-medium">
        {user.displayName.slice(0, 1).toUpperCase()}
        <span
          className={clsx(
            'absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white',
            dotColor,
          )}
          aria-label={user.status}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-800 truncate">{user.displayName}</div>
        <div className="text-[11px] text-slate-500 truncate">
          @{user.username}
          {user.lastSeenAt && user.status === 'offline' && (
            <span className="ml-1 text-slate-400">· last seen {relativeTime(user.lastSeenAt)}</span>
          )}
        </div>
      </div>
      {unread > 0 && (
        <span className="text-[10px] font-semibold bg-brand-600 text-white rounded-full px-2 py-0.5">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}

function GroupHeader({
  name,
  count,
  open,
  onToggle,
}: {
  name: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full px-3 py-2 flex items-center justify-between text-[11px] uppercase tracking-wide font-semibold text-slate-500 hover:bg-slate-50"
    >
      <span>{name}</span>
      <span className="flex items-center gap-2 text-slate-400">
        <span>{count}</span>
        <span className={clsx('transition', open ? 'rotate-90' : '')}>▸</span>
      </span>
    </button>
  );
}

export function Sidebar(): JSX.Element {
  const { user: me } = useAuth();
  const { device, decrypt } = useCrypto();
  const usersQ = useQuery({
    queryKey: ['users'],
    queryFn: () => api.listUsers().then((r) => r.users),
    staleTime: 15_000,
  });
  const groupsQ = useQuery({
    queryKey: ['groups'],
    queryFn: () => api.listGroups().then((r) => r.groups),
    staleTime: 60_000,
  });
  const conversationsQ = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.listConversations().then((r) => r.conversations),
  });

  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [multiSelect, setMultiSelect] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const nav = useNavigate();

  const { unreadByUser } = useMemo(
    () => computeUnread(conversationsQ.data ?? []),
    [conversationsQ.data],
  );

  const usersById = useMemo(() => {
    const m: Record<string, PublicUser> = {};
    for (const u of usersQ.data ?? []) m[u.id] = u;
    return m;
  }, [usersQ.data]);

  const filteredUser = (u: PublicUser) =>
    !filter ||
    u.displayName.toLowerCase().includes(filter.toLowerCase()) ||
    u.username.toLowerCase().includes(filter.toLowerCase());

  function toggle(uid: string): void {
    if (!multiSelect) {
      // Single select → open/start DM
      if (uid === me?.id) return;
      const existing = (conversationsQ.data ?? []).find(
        (c) =>
          c.type === 'internal' &&
          c.memberUserIds.length === 2 &&
          c.memberUserIds.includes(uid) &&
          c.memberUserIds.includes(me!.id),
      );
      if (existing) {
        nav(`/conversation/${existing.id}`);
        return;
      }
      // TODO(phase8): wire "start DM" modal that builds the conversation key via useCrypto.
      // Silently no-op for now; the conversation view page will pick this up.
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(uid) ? next.delete(uid) : next.add(uid);
      return next;
    });
  }

  const groupedUsers = useMemo(
    () => groupUsers(groupsQ.data ?? [], usersQ.data ?? []),
    [groupsQ.data, usersQ.data],
  );

  const groupOrder = groupedUsers.map((g) => g.id);
  const anyClosed = groupOrder.some((id) => openGroups[id] === false);

  // Noop: reference decrypt/device so the hook stays tree-shakable-aware.
  void decrypt;
  void device;

  return (
    <div className="h-full flex flex-col">
      <div className="p-2 border-b border-slate-200 space-y-2">
        <input
          type="search"
          placeholder="Filter people"
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="flex items-center justify-between">
          <button
            type="button"
            className={clsx(
              'text-xs font-medium px-2 py-1 rounded',
              multiSelect ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100',
            )}
            onClick={() => {
              setMultiSelect((v) => !v);
              setSelected(new Set());
            }}
          >
            {multiSelect ? `Selecting (${selected.size})` : 'Multi-select'}
          </button>
          {multiSelect && selected.size > 0 && (
            <button
              type="button"
              className="text-xs font-medium text-brand-700 hover:underline"
              onClick={() => {
                // TODO(phase8): create ad-hoc group conversation.
                alert('Ad-hoc group creation lands in Phase 8.');
              }}
            >
              Start group ({selected.size})
            </button>
          )}
          <button
            type="button"
            className="text-xs text-slate-500 hover:text-slate-800"
            onClick={() => {
              const target = !anyClosed; // if all open → close all, else open all
              setOpenGroups(Object.fromEntries(groupOrder.map((id) => [id, !target])));
            }}
          >
            {anyClosed ? 'Expand all' : 'Collapse all'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {groupedUsers.map((g) => {
          const open = openGroups[g.id] !== false;
          const visible = g.users.filter(filteredUser);
          if (filter && visible.length === 0) return null;
          return (
            <section key={g.id}>
              <GroupHeader
                name={g.name}
                count={visible.length}
                open={open}
                onToggle={() => setOpenGroups((prev) => ({ ...prev, [g.id]: !open }))}
              />
              {open &&
                visible.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    unread={unreadByUser[u.id] ?? 0}
                    selected={selected.has(u.id)}
                    onToggle={() => toggle(u.id)}
                    multiSelect={multiSelect}
                  />
                ))}
            </section>
          );
        })}
      </div>

      <div className="border-t border-slate-200 p-2">
        <NavLink
          to="/inbox"
          className="block text-xs text-slate-500 hover:text-slate-800 px-2 py-1"
        >
          Inbox view →
        </NavLink>
      </div>

      {/* Reference usersById so lint doesn't complain; used by Phase 8 for header avatars. */}
      <div className="hidden" data-users-loaded={Object.keys(usersById).length} />
    </div>
  );
}

function groupUsers(
  groups: Group[],
  users: PublicUser[],
): Array<{ id: string; name: string; users: PublicUser[] }> {
  const memberSet: Record<string, Set<string>> = {};
  for (const g of groups) memberSet[g.id] = new Set(g.members);
  const assigned = new Set<string>();
  const out = groups.map((g) => {
    const list = users.filter((u) => memberSet[g.id]!.has(u.id));
    for (const u of list) assigned.add(u.id);
    return { id: g.id, name: g.name, users: list };
  });
  const unassigned = users.filter((u) => !assigned.has(u.id));
  if (unassigned.length > 0) {
    out.push({ id: '__unassigned', name: 'Unassigned', users: unassigned });
  }
  return out;
}

function computeUnread(convs: ConversationSummary[]): { unreadByUser: Record<string, number> } {
  const out: Record<string, number> = {};
  for (const c of convs) {
    if (c.unreadCount === 0) continue;
    if (c.memberUserIds.length !== 2) continue;
    for (const uid of c.memberUserIds) out[uid] = (out[uid] ?? 0) + c.unreadCount;
  }
  return { unreadByUser: out };
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = Date.now() - t;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}
