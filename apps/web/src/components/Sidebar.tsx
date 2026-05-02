import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import type { ConversationSummary, Group, PublicUser } from '@vibe-connect/shared-types';
import { api } from '../api.js';
import {
  FIRM_RECIPIENT_ID,
  startExternalConversation,
  type BuildConversationKey,
} from '../lib/startExternalConversation.js';
import { isMultiPersonThread, threadLabel } from '../lib/threadLabel.js';
import { InviteClientModal, type InviteResendTarget } from './InviteClientModal.js';
import { useAuth } from '../state/auth.js';
import { useCrypto } from '../state/crypto.js';

type BuildKey = BuildConversationKey;

// Sort mode for the sidebar's contact lists. Persisted per browser (but not per
// device) so flipping to "recent" doesn't get lost on refresh. 'presence' keeps
// the long-standing behaviour (active → dnd → away → offline → inactive, alpha
// within each band). 'recent' re-orders by the most recent message in a 1:1
// conversation with the signed-in user; ties fall back to the same presence
// rank so the list stays stable when several people have no activity.
type SortMode = 'presence' | 'recent';
const SORT_MODE_STORAGE_KEY = 'vibe-connect:sidebar-sort-mode';

function readSortMode(): SortMode {
  try {
    return window.localStorage.getItem(SORT_MODE_STORAGE_KEY) === 'recent' ? 'recent' : 'presence';
  } catch {
    return 'presence';
  }
}

// Scope toggle for the Clients section. 'mine' keeps the list focused on the
// clients the signed-in user already shares an external conversation with —
// the common case, so it's the default. 'all' shows every reachable client
// at the firm (what the /clients endpoint returns) for moments when staff
// need to pick up someone else's thread or resend an invite colleagues sent.
type ClientScope = 'mine' | 'all';
const CLIENT_SCOPE_STORAGE_KEY = 'vibe-connect:sidebar-client-scope';

function readClientScope(): ClientScope {
  try {
    return window.localStorage.getItem(CLIENT_SCOPE_STORAGE_KEY) === 'all' ? 'all' : 'mine';
  } catch {
    return 'mine';
  }
}

async function startConversation(
  me: PublicUser,
  targets: PublicUser[],
  buildKey: BuildKey,
  displayName: string | null = null,
): Promise<string> {
  // Deduplicate — a "Notes to self" conversation passes `[me]` as its only target, which
  // would otherwise duplicate the actor's id.
  const rawIds = [me.id, ...targets.map((t) => t.id)];
  const userIds = Array.from(new Set(rawIds));
  const { keys } = await api.getUserDeviceKeys(userIds);
  const recipients: { id: string; publicKey: string }[] = [];
  const byId: Record<string, string> = { [me.id]: me.displayName };
  for (const t of targets) byId[t.id] = t.displayName;
  for (const uid of userIds) {
    const devices = keys[uid] ?? [];
    if (devices.length === 0) {
      const name = byId[uid] ?? uid;
      throw new Error(
        uid === me.id
          ? `Your account has no enrolled device yet — finish the enrollment step on this browser first.`
          : `${name} hasn't signed in on this appliance yet, so they have no device key to encrypt to. Ask them to sign in once, then try again.`,
      );
    }
    for (const d of devices) {
      recipients.push({ id: `${uid}:${d.deviceId}`, publicKey: d.publicKey });
    }
  }
  // CRYPTO: wrap to the firm recovery public key too. This is the backstop for
  // emergency recovery via the 24-word phrase, per the firm-recoverable trust
  // model in CLAUDE.md.
  const firmKey = await api.getFirmPublicKey();
  if (firmKey?.publicKey) {
    recipients.push({ id: FIRM_RECIPIENT_ID, publicKey: firmKey.publicKey });
  }
  const { wrappedKeys, rotationVersion } = await buildKey(recipients);
  const created = await api.createConversation({
    type: 'internal',
    memberUserIds: userIds,
    displayName,
    wrappedKeys,
    rotationVersion,
  });
  return created.id;
}

function UserRow({
  user,
  unread,
  selected,
  onToggle,
  multiSelect,
  isSelf,
}: {
  user: PublicUser;
  unread: number;
  selected: boolean;
  onToggle: () => void;
  multiSelect: boolean;
  isSelf: boolean;
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
        <div className="text-sm font-medium text-slate-800 truncate">
          {user.displayName}
          {isSelf && <span className="ml-1 text-[10px] text-slate-400">(you — notes to self)</span>}
        </div>
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

type ClientRow = {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  firmClientRef: string | null;
  invitedAt: string | null;
  invitedVia: 'email' | 'sms' | null;
  verificationType: 'ssn' | 'ein' | 'none';
  reverifyEveryHours?: 4 | 8 | 24 | 168 | null;
  emailNotifications?: boolean;
  smsNotifications?: boolean;
  lastActiveAt: string | null;
  activeSessions: number;
};

function ClientRowView({
  client,
  unread,
  onOpen,
}: {
  client: ClientRow;
  unread: number;
  onOpen: () => void;
}) {
  const hasActivated = Boolean(client.lastActiveAt);
  const statusDot = hasActivated
    ? client.activeSessions > 0
      ? 'bg-emerald-500'
      : 'bg-slate-300'
    : 'bg-amber-400';
  const subtitle = hasActivated
    ? client.activeSessions > 0
      ? 'Active in portal'
      : client.lastActiveAt
        ? `Last active ${relativeTime(client.lastActiveAt)}`
        : 'Portal account'
    : client.invitedAt
      ? `Invited ${relativeTime(client.invitedAt)} via ${client.invitedVia ?? 'email'}`
      : 'Invite pending';
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100"
    >
      <div className="relative w-8 h-8 rounded-full bg-amber-100 grid place-items-center text-amber-800 text-xs font-medium">
        {client.displayName.slice(0, 1).toUpperCase()}
        <span
          className={clsx(
            'absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white',
            statusDot,
          )}
          aria-label={hasActivated ? 'activated' : 'invite pending'}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-800 truncate">
          {client.displayName}
          {!hasActivated && <span className="ml-1 text-[10px] text-amber-700">(pending)</span>}
        </div>
        <div className="text-[11px] text-slate-500 truncate">{subtitle}</div>
      </div>
      {unread > 0 && (
        <span className="text-[10px] font-semibold bg-brand-600 text-white rounded-full px-2 py-0.5">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}

function ThreadRow({
  label,
  memberCount,
  unread,
  lastMessageAt,
  onOpen,
}: {
  label: string;
  memberCount: number;
  unread: number;
  lastMessageAt: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100"
    >
      <div
        className="relative w-8 h-8 rounded-full bg-brand-100 grid place-items-center text-brand-700 text-[11px] font-semibold"
        aria-hidden
      >
        {memberCount > 99 ? '99+' : memberCount}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-800 truncate">{label}</div>
        <div className="text-[11px] text-slate-500 truncate">
          {lastMessageAt ? relativeTime(lastMessageAt) : 'No messages yet'}
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
  const { device, decrypt, buildConversationKey } = useCrypto();
  const queryClient = useQueryClient();
  const [startError, setStartError] = useState<string | null>(null);
  const [groupName, setGroupName] = useState<string>('');
  const [groupPromptOpen, setGroupPromptOpen] = useState(false);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  // Pending-client resend flow. Clicking an invited-but-not-activated client
  // in the sidebar opens this panel; from there the staff can either resend
  // the invite (with corrections) or open the draft conversation anyway.
  const [pendingActionFor, setPendingActionFor] = useState<ClientRow | null>(null);
  const [resendTarget, setResendTarget] = useState<InviteResendTarget | null>(null);
  const [resendFlash, setResendFlash] = useState<string | null>(null);
  // IMPORTANT: queryFn return shape must match every other useQuery using the same
  // queryKey, because TanStack Query caches by key — whichever component hits it
  // first wins. Admin → Users uses the full `{users: [...]}` object, so we do too
  // and unwrap at the read site. Same for groups / conversations.
  const usersQ = useQuery({
    queryKey: ['users'],
    queryFn: () => api.listUsers(),
    staleTime: 15_000,
  });
  const groupsQ = useQuery({
    queryKey: ['groups'],
    queryFn: () => api.listGroups(),
    staleTime: 60_000,
  });
  const conversationsQ = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.listConversations(),
  });
  // Firm security policy drives whether to show the Clients section at all.
  const policyQ = useQuery({
    queryKey: ['security-policy'],
    queryFn: () => api.getSecurityPolicy(),
    staleTime: 60_000,
  });
  const clientMessagingEnabled = policyQ.data?.clientMessagingEnabled !== false;
  const firmName = policyQ.data?.firmName ?? 'Your Firm';
  const smsAvailable = Boolean(policyQ.data?.smsAvailable);
  // stepupTimeoutHours = -1 means "always re-verify" at the firm level
  // (server stores verified_until = null, which the portal reads as
  // "stepup needed"). The modal's dropdown handles that via its "Never"
  // option, but for the default selection a -1 would leave the field
  // ungrounded — fall back to 24.
  const rawStepup = policyQ.data?.stepupTimeoutHours ?? 24;
  const defaultReverifyHours: 4 | 8 | 24 | 168 =
    rawStepup === 4 || rawStepup === 8 || rawStepup === 24 || rawStepup === 168 ? rawStepup : 24;
  const clientsQ = useQuery({
    queryKey: ['clients', 'messageable'],
    queryFn: () => api.listClients(),
    staleTime: 30_000,
    enabled: clientMessagingEnabled,
  });

  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [multiSelect, setMultiSelect] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [sortMode, setSortModeState] = useState<SortMode>(() => readSortMode());
  const setSortMode = useCallback((m: SortMode) => {
    setSortModeState(m);
    try {
      window.localStorage.setItem(SORT_MODE_STORAGE_KEY, m);
    } catch {
      /* localStorage may be unavailable in private-browsing / strict-storage modes */
    }
  }, []);
  const [clientScope, setClientScopeState] = useState<ClientScope>(() => readClientScope());
  const setClientScope = useCallback((s: ClientScope) => {
    setClientScopeState(s);
    try {
      window.localStorage.setItem(CLIENT_SCOPE_STORAGE_KEY, s);
    } catch {
      /* localStorage may be unavailable in private-browsing / strict-storage modes */
    }
  }, []);
  const nav = useNavigate();

  // Memoize the unwrapped lists so ??-fallback empty arrays stay referentially
  // stable across renders — otherwise downstream useMemos re-compute every paint.
  const conversations = useMemo(
    () => conversationsQ.data?.conversations ?? [],
    [conversationsQ.data],
  );
  const users = useMemo(() => usersQ.data?.users ?? [], [usersQ.data]);
  const groups = useMemo(() => groupsQ.data?.groups ?? [], [groupsQ.data]);
  const clients = useMemo(() => clientsQ.data?.clients ?? [], [clientsQ.data]);

  const { unreadByUser, unreadByClient } = useMemo(
    () => computeUnread(conversations),
    [conversations],
  );

  // Per-contact "last activity" timestamps — only 1:1 staff DMs, Notes-to-self,
  // and single-client external conversations count. Group conversations live in
  // a separate surface, so folding their recency into staff-user ordering would
  // bias whoever shared the most groups with you to the top. Integers so the
  // sort comparator doesn't pay Date parse costs per pair.
  const activityByUser = useMemo(() => {
    const out: Record<string, number> = {};
    if (!me) return out;
    for (const c of conversations) {
      if (c.type !== 'internal') continue;
      const t = c.lastMessageAt ? Date.parse(c.lastMessageAt) : 0;
      if (!t) continue;
      if (c.memberUserIds.length === 1 && c.memberUserIds[0] === me.id) {
        // Notes-to-self — credit recency to the self row.
        out[me.id] = Math.max(out[me.id] ?? 0, t);
        continue;
      }
      if (c.memberUserIds.length !== 2 || !c.memberUserIds.includes(me.id)) continue;
      const peer = c.memberUserIds[0] === me.id ? c.memberUserIds[1]! : c.memberUserIds[0]!;
      out[peer] = Math.max(out[peer] ?? 0, t);
    }
    return out;
  }, [conversations, me]);

  const activityByClient = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of conversations) {
      if (c.type !== 'external') continue;
      if (c.memberExternalIdentityIds.length !== 1) continue;
      const t = c.lastMessageAt ? Date.parse(c.lastMessageAt) : 0;
      if (!t) continue;
      const cid = c.memberExternalIdentityIds[0]!;
      out[cid] = Math.max(out[cid] ?? 0, t);
    }
    return out;
  }, [conversations]);

  // Set of client IDs the signed-in user shares any external conversation with.
  // listConversations is already scoped to this user server-side, so "client
  // appears in my conversations" is equivalent to "client the user has chatted
  // with" — including pending clients they invited (the invite flow creates
  // the conversation up front) and multi-client external threads they joined.
  const myClientIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      if (c.type !== 'external') continue;
      for (const id of c.memberExternalIdentityIds) set.add(id);
    }
    return set;
  }, [conversations]);

  const usersById = useMemo(() => {
    const m: Record<string, PublicUser> = {};
    for (const u of users) m[u.id] = u;
    return m;
  }, [users]);

  const filteredUser = (u: PublicUser) =>
    !filter ||
    u.displayName.toLowerCase().includes(filter.toLowerCase()) ||
    u.username.toLowerCase().includes(filter.toLowerCase());

  function openConversationForClient(client: ClientRow): void {
    if (!me) return;
    const existing = conversations.find(
      (c) =>
        c.type === 'external' &&
        c.memberExternalIdentityIds.length === 1 &&
        c.memberExternalIdentityIds[0] === client.id,
    );
    if (existing) {
      nav(`/conversation/${existing.id}`);
      return;
    }
    setStartError(null);
    startExternalConversation(
      me,
      { id: client.id, displayName: client.displayName },
      buildConversationKey,
    )
      .then((id) => nav(`/conversation/${id}`))
      .catch((err: Error) => setStartError(err.message));
  }

  function toggleClient(cid: string): void {
    if (!me) return;
    const client = clients.find((c) => c.id === cid);
    if (!client) return;
    // Pending clients (not yet activated) get a resend-or-open panel instead
    // of jumping straight into a conversation — resending the invite rotates
    // the invite_public_key, which would strand any pre-activation drafts,
    // so surfacing the choice here keeps staff from losing work by accident.
    if (!client.lastActiveAt) {
      setPendingActionFor(client);
      return;
    }
    openConversationForClient(client);
  }

  function toggle(uid: string): void {
    if (!multiSelect) {
      // Single select → open/start DM. Clicking yourself opens a "Notes to self"
      // solo conversation — handy for encrypted reminders that sync across your
      // own devices.
      if (!me) return;
      const isSelf = uid === me.id;
      const existing = conversations.find((c) => {
        if (c.type !== 'internal') return false;
        if (isSelf) {
          return c.memberUserIds.length === 1 && c.memberUserIds[0] === me.id;
        }
        return (
          c.memberUserIds.length === 2 &&
          c.memberUserIds.includes(uid) &&
          c.memberUserIds.includes(me.id)
        );
      });
      if (existing) {
        nav(`/conversation/${existing.id}`);
        return;
      }
      const target = isSelf ? null : usersById[uid];
      if (!isSelf && !target) return;
      setStartError(null);
      const targets = isSelf ? [] : [target!];
      const displayName = isSelf ? 'Notes to self' : null;
      startConversation(me, targets, buildConversationKey, displayName)
        .then((id) => nav(`/conversation/${id}`))
        .catch((err: Error) => setStartError(err.message));
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(uid) ? next.delete(uid) : next.add(uid);
      return next;
    });
  }

  const groupedUsers = useMemo(
    () => groupUsers(groups, users, sortMode, activityByUser),
    [groups, users, sortMode, activityByUser],
  );

  // Multi-person internal threads (groups + ad-hoc "Message N"). 1:1 DMs are
  // already rendered via staff-user rows, so they're excluded here.
  const threads = useMemo(() => {
    const base = conversations.filter((c) => isMultiPersonThread(c, me?.id ?? null));
    const withLabel = base.map((c) => ({
      id: c.id,
      label: threadLabel(c, usersById, me?.id ?? null),
      memberCount: c.memberUserIds.length,
      unread: c.unreadCount,
      lastMessageAt: c.lastMessageAt,
    }));
    if (sortMode === 'recent') {
      withLabel.sort((a, b) => {
        const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
        const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
        if (ta !== tb) return tb - ta;
        return a.label.localeCompare(b.label);
      });
    } else {
      withLabel.sort((a, b) => a.label.localeCompare(b.label));
    }
    return withLabel;
  }, [conversations, usersById, me, sortMode]);

  // Global shortcut Ctrl/Cmd+Shift+I opens the invite modal when staff app is
  // focused. Ignored while the user is typing into a text field so it doesn't
  // fight browser dev-tools bindings inside inputs — matches the sidebar spec.
  useEffect(() => {
    if (!clientMessagingEnabled) return;
    function onKey(e: KeyboardEvent): void {
      if (!(e.shiftKey && (e.ctrlKey || e.metaKey))) return;
      if (e.key.toLowerCase() !== 'i') return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      setInviteModalOpen(true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clientMessagingEnabled]);

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
                setStartError(null);
                setGroupName('');
                setGroupPromptOpen(true);
              }}
            >
              Message {selected.size}
            </button>
          )}
          <div
            role="group"
            aria-label="Contact sort order"
            className="inline-flex rounded bg-slate-100 p-0.5 text-[11px] font-medium"
          >
            <button
              type="button"
              onClick={() => setSortMode('presence')}
              aria-pressed={sortMode === 'presence'}
              title="Sort alphabetically within each group (presence-aware)"
              className={clsx(
                'px-2 py-0.5 rounded',
                sortMode === 'presence'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-800',
              )}
            >
              A–Z
            </button>
            <button
              type="button"
              onClick={() => setSortMode('recent')}
              aria-pressed={sortMode === 'recent'}
              title="Sort by most recent message first"
              className={clsx(
                'px-2 py-0.5 rounded',
                sortMode === 'recent'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-800',
              )}
            >
              Recent
            </button>
          </div>
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
                    isSelf={u.id === me?.id}
                  />
                ))}
            </section>
          );
        })}
        {clientMessagingEnabled &&
          (() => {
            const clientFilter = (c: ClientRow) =>
              !filter ||
              c.displayName.toLowerCase().includes(filter.toLowerCase()) ||
              (c.email?.toLowerCase().includes(filter.toLowerCase()) ?? false) ||
              (c.phone?.includes(filter) ?? false);
            const scopeFilter = (c: ClientRow) => clientScope === 'all' || myClientIds.has(c.id);
            const filtered = clients.filter((c) => scopeFilter(c) && clientFilter(c));
            // Sibling count we can surface when 'mine' is empty — lets the user
            // know the firm has clients to look at even if none match their
            // personal scope yet, and lines up the "Show all" hint below.
            const allFilteredCount = clients.filter(clientFilter).length;
            // The /clients endpoint returns rows in alphabetical displayName order
            // already. In 'recent' mode, re-sort by the most recent external
            // message; clients with no history keep the server's A→Z order at the
            // bottom. Copy before sorting to avoid mutating the query-cached array.
            const visible =
              sortMode === 'recent'
                ? [...filtered].sort((a, b) => {
                    const ta = activityByClient[a.id] ?? 0;
                    const tb = activityByClient[b.id] ?? 0;
                    if (ta !== tb) return tb - ta;
                    return a.displayName.localeCompare(b.displayName);
                  })
                : filtered;
            const open = openGroups['__clients'] !== false;
            if (filter && visible.length === 0 && clientScope === 'all') return null;
            return (
              <section key="__clients">
                <GroupHeader
                  name="Clients"
                  count={visible.length}
                  open={open}
                  onToggle={() => setOpenGroups((prev) => ({ ...prev, ['__clients']: !open }))}
                />
                {open && (
                  <div className="px-3 py-1.5 flex items-center justify-between">
                    <div
                      role="group"
                      aria-label="Client visibility scope"
                      className="inline-flex rounded bg-slate-100 p-0.5 text-[10px] font-medium"
                    >
                      <button
                        type="button"
                        onClick={() => setClientScope('mine')}
                        aria-pressed={clientScope === 'mine'}
                        title="Only clients you share a conversation with"
                        className={clsx(
                          'px-2 py-0.5 rounded',
                          clientScope === 'mine'
                            ? 'bg-white text-slate-800 shadow-sm'
                            : 'text-slate-500 hover:text-slate-800',
                        )}
                      >
                        Mine
                      </button>
                      <button
                        type="button"
                        onClick={() => setClientScope('all')}
                        aria-pressed={clientScope === 'all'}
                        title="Every reachable client at the firm"
                        className={clsx(
                          'px-2 py-0.5 rounded',
                          clientScope === 'all'
                            ? 'bg-white text-slate-800 shadow-sm'
                            : 'text-slate-500 hover:text-slate-800',
                        )}
                      >
                        All
                      </button>
                    </div>
                  </div>
                )}
                {open && (
                  <button
                    type="button"
                    onClick={() => setInviteModalOpen(true)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-medium text-brand-700 hover:bg-brand-50"
                  >
                    <span className="w-5 h-5 rounded-full border border-brand-300 grid place-items-center text-sm leading-none">
                      +
                    </span>
                    Invite a client
                    <span className="ml-auto text-[10px] text-slate-400 hidden md:inline">⌘⇧I</span>
                  </button>
                )}
                {open &&
                  visible.map((c) => (
                    <ClientRowView
                      key={c.id}
                      client={c}
                      unread={unreadByClient[c.id] ?? 0}
                      onOpen={() => toggleClient(c.id)}
                    />
                  ))}
                {open && visible.length === 0 && !clientsQ.isLoading && (
                  <p className="px-3 py-2 text-[11px] text-slate-500">
                    {clientScope === 'mine' && allFilteredCount > 0 ? (
                      <>
                        You haven&apos;t started a conversation with anyone yet.{' '}
                        <button
                          type="button"
                          onClick={() => setClientScope('all')}
                          className="text-brand-700 hover:underline font-medium"
                        >
                          Show all {allFilteredCount}
                        </button>
                        .
                      </>
                    ) : (
                      <>
                        No clients yet — click <strong>Invite a client</strong> above to reach one.
                      </>
                    )}
                  </p>
                )}
              </section>
            );
          })()}
        {(() => {
          if (threads.length === 0) return null;
          const lcFilter = filter.toLowerCase();
          const visible = filter
            ? threads.filter((t) => t.label.toLowerCase().includes(lcFilter))
            : threads;
          const open = openGroups['__threads'] !== false;
          if (filter && visible.length === 0) return null;
          return (
            <section key="__threads">
              <GroupHeader
                name="Threads"
                count={visible.length}
                open={open}
                onToggle={() => setOpenGroups((prev) => ({ ...prev, ['__threads']: !open }))}
              />
              {open &&
                visible.map((t) => (
                  <ThreadRow
                    key={t.id}
                    label={t.label}
                    memberCount={t.memberCount}
                    unread={t.unread}
                    lastMessageAt={t.lastMessageAt}
                    onOpen={() => nav(`/conversation/${t.id}`)}
                  />
                ))}
            </section>
          );
        })()}
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

      {startError && (
        // `fixed` + high z-index + viewport-relative so this is never clipped by the
        // sidebar's overflow-hidden parent. Previously the toast rendered INSIDE
        // the `<aside>` with `overflow-hidden`, which hid it — the user saw "nothing
        // happens" on click when actually an error was being raised.
        <div className="fixed bottom-4 right-4 max-w-sm bg-rose-50 border border-rose-200 text-rose-800 text-sm rounded-md px-3 py-2 shadow-lg z-50">
          <div className="flex justify-between items-start gap-2">
            <span>{startError}</span>
            <button
              type="button"
              onClick={() => setStartError(null)}
              className="text-rose-500 hover:text-rose-800"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {groupPromptOpen && me && (
        <div
          className="fixed inset-0 bg-slate-900/40 grid place-items-center p-4 z-50"
          onClick={() => setGroupPromptOpen(false)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              setStartError(null);
              const targets = users.filter((u) => selected.has(u.id));
              if (targets.length === 0) {
                setStartError('Select at least one participant.');
                return;
              }
              const name = groupName.trim();
              // Dedupe only when the user didn't name the conversation. If they
              // typed a name they're explicitly asking for a new named thread —
              // don't pull them into an unrelated unnamed conversation that
              // happens to share the same members. For the ad-hoc path
              // (blank name), find any unnamed conversation with the exact same
              // roster and navigate there so re-clicking "Message N" can't
              // splinter the ad-hoc thread into duplicates.
              if (!name) {
                const memberSet = new Set([me.id, ...targets.map((t) => t.id)]);
                const match = conversations.find((c) => {
                  if (c.type !== 'internal') return false;
                  if (c.displayName) return false;
                  if (c.memberUserIds.length !== memberSet.size) return false;
                  return c.memberUserIds.every((uid) => memberSet.has(uid));
                });
                if (match) {
                  setGroupPromptOpen(false);
                  setMultiSelect(false);
                  setSelected(new Set());
                  nav(`/conversation/${match.id}`);
                  return;
                }
              }
              startConversation(me, targets, buildConversationKey, name || null)
                .then((id) => {
                  setGroupPromptOpen(false);
                  setMultiSelect(false);
                  setSelected(new Set());
                  nav(`/conversation/${id}`);
                })
                .catch((err: Error) => setStartError(err.message));
            }}
            className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 space-y-3"
          >
            <h3 className="font-semibold text-slate-900">
              Message {selected.size} {selected.size === 1 ? 'person' : 'people'}
            </h3>
            <label className="block">
              <span className="text-sm text-slate-700">Group name (optional)</span>
              <input
                autoFocus
                maxLength={120}
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="Leave blank for a quick message"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <span className="block mt-1 text-[11px] text-slate-500">
                Add a name to start an ongoing group. Leave it blank and we&apos;ll reuse any
                existing unnamed thread with these same people.
              </span>
            </label>
            <p className="text-xs text-slate-500">
              A fresh conversation key is generated client-side and wrapped to every selected staff
              member&apos;s active devices plus the firm recovery key.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setGroupPromptOpen(false)}
                className="rounded-md border border-slate-300 text-slate-700 text-sm px-3 py-1.5 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-md bg-brand-600 text-white text-sm font-medium px-3 py-1.5 hover:bg-brand-700"
              >
                {groupName.trim() ? 'Create group' : 'Start message'}
              </button>
            </div>
          </form>
        </div>
      )}

      <InviteClientModal
        open={inviteModalOpen && clientMessagingEnabled}
        onClose={() => setInviteModalOpen(false)}
        firmName={firmName}
        defaultReverifyHours={defaultReverifyHours}
        smsAvailable={smsAvailable}
        onCreated={(result) => {
          setInviteModalOpen(false);
          // Refresh the clients list so the newly invited client shows up as
          // "pending" if the user reopens the sidebar group — and the
          // conversations list so the new conversation slot is populated.
          void queryClient.invalidateQueries({ queryKey: ['clients', 'messageable'] });
          void queryClient.invalidateQueries({ queryKey: ['conversations'] });
          if (result.conversationId) nav(`/conversation/${result.conversationId}`);
        }}
        onOpenExistingClient={(clientId, clientDisplayName) => {
          if (!me) return;
          // Prefer a conversation we already have open with this identity —
          // avoids a duplicate external conversation when the clients list is
          // slightly stale vs. the server. Falls back to creating one on the
          // fly (fetches the existing invite_public_key server-side) so even
          // newly-recovered duplicates land in a usable place.
          const existing = conversations.find(
            (c) =>
              c.type === 'external' &&
              c.memberExternalIdentityIds.length === 1 &&
              c.memberExternalIdentityIds[0] === clientId,
          );
          if (existing) {
            setInviteModalOpen(false);
            nav(`/conversation/${existing.id}`);
            return;
          }
          setStartError(null);
          startExternalConversation(
            me,
            { id: clientId, displayName: clientDisplayName },
            buildConversationKey,
          )
            .then((id) => {
              setInviteModalOpen(false);
              void queryClient.invalidateQueries({ queryKey: ['conversations'] });
              nav(`/conversation/${id}`);
            })
            .catch((err: Error) => setStartError(err.message));
        }}
      />

      {/* Pending-client action sheet — shown when staff clicks an invited
          client before they've activated. Two primary actions: "Resend
          invite" (rotates invite key via the dedicated modal) and "Open
          draft conversation" (the original click behaviour, preserved for
          teams who draft messages ahead of acceptance). */}
      {pendingActionFor && clientMessagingEnabled && (
        <div
          className="fixed inset-0 z-50 grid place-items-center p-4 bg-slate-900/40"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pending-action-title"
          onClick={() => setPendingActionFor(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden"
          >
            <header className="px-4 py-3 border-b border-slate-200">
              <h3 id="pending-action-title" className="text-sm font-semibold text-slate-900">
                {pendingActionFor.displayName}
              </h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Invite pending
                {pendingActionFor.invitedAt
                  ? ` · sent ${relativeTime(pendingActionFor.invitedAt)} via ${
                      pendingActionFor.invitedVia ?? 'email'
                    }`
                  : ''}
              </p>
            </header>
            <div className="p-3 space-y-2">
              <button
                type="button"
                onClick={() => {
                  const target: InviteResendTarget = {
                    clientId: pendingActionFor.id,
                    displayName: pendingActionFor.displayName,
                    email: pendingActionFor.email,
                    phone: pendingActionFor.phone,
                    firmClientRef: pendingActionFor.firmClientRef,
                    invitedVia: pendingActionFor.invitedVia,
                    verificationType: pendingActionFor.verificationType,
                    reverifyEveryHours: pendingActionFor.reverifyEveryHours,
                    emailNotifications: pendingActionFor.emailNotifications,
                    smsNotifications: pendingActionFor.smsNotifications,
                  };
                  setResendTarget(target);
                  setPendingActionFor(null);
                }}
                className="w-full rounded-md bg-brand-600 text-white text-sm font-medium px-3 py-2 hover:bg-brand-700"
              >
                Resend invite
              </button>
              <button
                type="button"
                onClick={() => {
                  const client = pendingActionFor;
                  setPendingActionFor(null);
                  openConversationForClient(client);
                }}
                className="w-full rounded-md border border-slate-300 text-slate-700 text-sm font-medium px-3 py-2 hover:bg-slate-50"
              >
                Open draft conversation
              </button>
              <button
                type="button"
                onClick={() => setPendingActionFor(null)}
                className="w-full text-xs text-slate-500 hover:text-slate-700 py-1"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <InviteClientModal
        open={resendTarget !== null && clientMessagingEnabled}
        onClose={() => setResendTarget(null)}
        firmName={firmName}
        defaultReverifyHours={defaultReverifyHours}
        smsAvailable={smsAvailable}
        autoStartConversation={false}
        resendTarget={resendTarget}
        onCreated={(result) => {
          setResendTarget(null);
          void queryClient.invalidateQueries({ queryKey: ['clients', 'messageable'] });
          const email = result.deliveryStatus.email;
          const sms = result.deliveryStatus.sms;
          const parts: string[] = [];
          if (email === 'sent') parts.push('email sent');
          else if (email === 'failed') parts.push('email failed');
          if (sms === 'sent') parts.push('SMS sent');
          else if (sms === 'failed') parts.push('SMS failed');
          setResendFlash(
            `Re-invited ${result.displayName}${parts.length > 0 ? ` — ${parts.join(', ')}` : ''}.`,
          );
          window.setTimeout(() => setResendFlash(null), 6_000);
        }}
        onOpenExistingClient={(clientId, clientDisplayName) => {
          // 409 on resend means email/phone now collide with another identity.
          // Bail out of the resend flow and open that other client's
          // conversation so the staff can reconcile in one place.
          if (!me) return;
          setResendTarget(null);
          const existing = conversations.find(
            (c) =>
              c.type === 'external' &&
              c.memberExternalIdentityIds.length === 1 &&
              c.memberExternalIdentityIds[0] === clientId,
          );
          if (existing) {
            nav(`/conversation/${existing.id}`);
            return;
          }
          startExternalConversation(
            me,
            { id: clientId, displayName: clientDisplayName },
            buildConversationKey,
          )
            .then((id) => {
              void queryClient.invalidateQueries({ queryKey: ['conversations'] });
              nav(`/conversation/${id}`);
            })
            .catch((err: Error) => setStartError(err.message));
        }}
      />

      {resendFlash && (
        <div className="fixed bottom-4 right-4 max-w-sm bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm rounded-md px-3 py-2 shadow-lg z-50">
          <div className="flex justify-between items-start gap-2">
            <span>{resendFlash}</span>
            <button
              type="button"
              onClick={() => setResendFlash(null)}
              className="text-emerald-700 hover:text-emerald-900"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Lower rank = higher in the list. Active staff surface first; DND/away stay
// ahead of offline; offline users with recent last-seen jump above those never
// seen. Inactive users drop to the bottom.
function presenceRank(u: PublicUser): number {
  if (!u.isActive) return 9;
  switch (u.status) {
    case 'active':
      return 0;
    case 'dnd':
      return 1;
    case 'away':
      return 2;
    case 'offline':
    default:
      return u.lastSeenAt ? 3 : 4;
  }
}

function sortByPresence(users: PublicUser[]): PublicUser[] {
  return [...users].sort((a, b) => {
    const ra = presenceRank(a);
    const rb = presenceRank(b);
    if (ra !== rb) return ra - rb;
    return a.displayName.localeCompare(b.displayName);
  });
}

// 'recent' mode: sort by last-message timestamp descending so the person you
// just heard from floats to the top. Anyone with no 1:1 history drops to the
// bottom in the same presence+alpha order we used to show in 'presence' mode,
// which keeps the list from shuffling unpredictably when you open a fresh
// appliance where most staff have no DM history yet.
function sortByActivity(users: PublicUser[], activity: Record<string, number>): PublicUser[] {
  return [...users].sort((a, b) => {
    const ta = activity[a.id] ?? 0;
    const tb = activity[b.id] ?? 0;
    if (ta !== tb) return tb - ta;
    const ra = presenceRank(a);
    const rb = presenceRank(b);
    if (ra !== rb) return ra - rb;
    return a.displayName.localeCompare(b.displayName);
  });
}

function groupUsers(
  groups: Group[],
  users: PublicUser[],
  sortMode: SortMode,
  activityByUser: Record<string, number>,
): Array<{ id: string; name: string; users: PublicUser[] }> {
  const memberSet: Record<string, Set<string>> = {};
  for (const g of groups) memberSet[g.id] = new Set(g.members);
  const assigned = new Set<string>();
  const sort = (list: PublicUser[]): PublicUser[] =>
    sortMode === 'recent' ? sortByActivity(list, activityByUser) : sortByPresence(list);
  const out = groups.map((g) => {
    const list = sort(users.filter((u) => memberSet[g.id]!.has(u.id)));
    for (const u of list) assigned.add(u.id);
    return { id: g.id, name: g.name, users: list };
  });
  const unassigned = sort(users.filter((u) => !assigned.has(u.id)));
  if (unassigned.length > 0) {
    out.push({ id: '__unassigned', name: 'Unassigned', users: unassigned });
  }
  return out;
}

function computeUnread(convs: ConversationSummary[]): {
  unreadByUser: Record<string, number>;
  unreadByClient: Record<string, number>;
} {
  const byUser: Record<string, number> = {};
  const byClient: Record<string, number> = {};
  for (const c of convs) {
    if (c.unreadCount === 0) continue;
    if (c.type === 'external' && c.memberExternalIdentityIds.length === 1) {
      const cid = c.memberExternalIdentityIds[0]!;
      byClient[cid] = (byClient[cid] ?? 0) + c.unreadCount;
      continue;
    }
    if (c.memberUserIds.length !== 2) continue;
    for (const uid of c.memberUserIds) byUser[uid] = (byUser[uid] ?? 0) + c.unreadCount;
  }
  return { unreadByUser: byUser, unreadByClient: byClient };
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
