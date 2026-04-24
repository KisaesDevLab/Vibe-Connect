// Thin JSON + form fetch wrappers. Always include credentials so the session cookie flows.
import type {
  ConversationSummary,
  DecryptedMessage,
  EncryptedMessage,
  FirmPublicKey,
  Group,
  InviteClientRequest,
  InviteClientResponse,
  PublicUser,
  TlsStatus,
} from '@vibe-connect/shared-types';

const base = ''; // same-origin via Vite proxy in dev; Nginx in prod.

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${input}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`${res.status}: ${body}`), { status: res.status, body });
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login: (username: string, password: string) =>
    json<{ user: PublicUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => json<{ ok: true }>('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    json<{ ok: true }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  uploadAvatar: async (file: File): Promise<{ avatarUrl: string }> => {
    const form = new FormData();
    form.set('avatar', file);
    const r = await fetch('/users/me/avatar', {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!r.ok) throw new Error(`avatar_upload_${r.status}`);
    return (await r.json()) as { avatarUrl: string };
  },
  me: () => json<{ user: PublicUser }>('/auth/me'),
  oidcConfig: () =>
    json<{ enabled: boolean; loginUrl: string | null }>('/auth/oidc/config').catch(() => ({
      enabled: false,
      loginUrl: null,
    })),

  installStatus: () => json<{ installed: boolean; hasAdmin: boolean }>('/install/status'),
  install: (body: {
    firmName: string;
    adminUsername: string;
    adminPassword: string;
    adminDisplayName: string;
    adminEmail?: string;
  }) =>
    json<{
      ok: true;
      firmPublicKey: string;
      recoveryPhrase: string[];
      adminUserId: string;
    }>('/install/install', { method: 'POST', body: JSON.stringify(body) }),

  listUsers: () => json<{ users: PublicUser[] }>('/users'),
  createUser: (body: {
    username: string;
    password: string;
    displayName: string;
    email?: string | null;
    isAdmin?: boolean;
  }) =>
    json<{ user: PublicUser }>('/users', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateUser: (
    id: string,
    body: {
      displayName?: string;
      email?: string | null;
      isAdmin?: boolean;
      isActive?: boolean;
    },
  ) =>
    json<{ user: PublicUser }>(`/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  resetUserPassword: (id: string, adminPassword: string, newPassword: string) =>
    json<{ ok: true }>(`/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ adminPassword, newPassword }),
    }),

  bulkImportUsers: (
    users: Array<{
      username: string;
      email?: string;
      displayName: string;
      initialPassword: string;
      isAdmin?: boolean;
      groupIds?: string[];
    }>,
  ) =>
    json<{
      created: string[];
      skipped: Array<{ username: string; reason: string }>;
    }>('/admin/users/bulk', {
      method: 'POST',
      body: JSON.stringify({ users }),
    }),

  createGroup: (body: { name: string; sortOrder?: number }) =>
    json<{ group: Group }>('/groups', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  renameGroup: (id: string, name: string) =>
    json<{ group: Group }>(`/groups/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteGroup: (id: string) =>
    json<{ ok: true }>(`/groups/${id}`, { method: 'DELETE' }),
  addGroupMember: (groupId: string, userId: string) =>
    json<{ ok: true }>(`/groups/${groupId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  removeGroupMember: (groupId: string, userId: string) =>
    json<{ ok: true }>(`/groups/${groupId}/members/${userId}`, {
      method: 'DELETE',
    }),
  listGroups: () => json<{ groups: Group[] }>('/groups'),

  listConversations: () => json<{ conversations: ConversationSummary[] }>('/conversations'),
  getConversation: (id: string) =>
    json<{
      id: string;
      type: string;
      parentConversationId: string | null;
      displayName: string | null;
      members: Array<{
        userId: string | null;
        externalIdentityId: string | null;
        joinedAt: string;
      }>;
      rotationVersion: number | null;
      wrappedKeys: Record<string, string> | null;
      // New: keyed by stringified rotation_version. The decrypt path uses
      // the entry matching each message's contentKeyVersion — essential for
      // reading history after a rotation.
      wrappedKeysByVersion: Record<string, Record<string, string>>;
    }>(`/conversations/${id}`),
  createConversation: (body: {
    type: 'internal' | 'external';
    memberUserIds: string[];
    memberExternalIdentityIds?: string[];
    displayName?: string | null;
    wrappedKeys: Record<string, string>;
    rotationVersion?: number;
  }) => json<{ id: string }>('/conversations', { method: 'POST', body: JSON.stringify(body) }),

  // Additive-only rewrap. When a member enrolls a new device, any already-enrolled
  // device of the same user PATCHes in a fresh sealed copy of the conversation key
  // for the new recipient id. The server rejects overwrites so races between
  // devices can't lock anyone out.
  patchWrappedKeys: (conversationId: string, added: Record<string, string>) =>
    json<{ ok: true; added: string[]; rotationVersion: number }>(
      `/conversations/${conversationId}/wrapped-keys`,
      { method: 'PATCH', body: JSON.stringify({ added }) },
    ),

  listMessages: (conversationId: string, opts: { beforeId?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.beforeId) q.set('beforeId', opts.beforeId);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return json<{ messages: EncryptedMessage[] }>(
      `/conversations/${conversationId}/messages${qs ? '?' + qs : ''}`,
    );
  },
  sendMessage: (
    conversationId: string,
    payload: {
      ciphertext: string;
      contentKeyVersion: number;
      urgent?: boolean;
      scheduledFor?: string | null;
      ciphertextMeta?: Record<string, unknown>;
    },
    opts?: { idempotencyKey?: string },
  ) =>
    json<{ id: string; createdAt: string; scheduledFor: string | null }>(
      `/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: opts?.idempotencyKey
          ? { 'X-Idempotency-Key': opts.idempotencyKey }
          : undefined,
      },
    ),
  editMessage: (
    messageId: string,
    payload: { ciphertext: string; ciphertextMeta: Record<string, unknown> },
  ) =>
    json<{ id: string; editedAt: string }>(`/conversations/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteMessage: (messageId: string) =>
    json<{ ok: true }>(`/conversations/messages/${messageId}`, { method: 'DELETE' }),
  markRead: (messageId: string) =>
    json<{ ok: true }>(`/conversations/messages/${messageId}/read`, { method: 'POST' }),
  ack: (messageId: string) =>
    json<{ ok: true }>(`/conversations/messages/${messageId}/ack`, { method: 'POST' }),

  // Firm key: the server exposes the public half so clients can wrap keys to it.
  getFirmPublicKey: () => json<FirmPublicKey | null>('/firm/public-key').catch(() => null),
  getFirmKeyMeta: () =>
    json<{ publicKey: string; rotationVersion: number; createdAt: string } | null>(
      '/firm/key-meta',
    ).catch(() => null),
  getSecurityPolicy: () =>
    json<{
      idleLockMinutes: number;
      clientMessagingEnabled?: boolean;
      firmName?: string;
      stepupTimeoutHours?: 4 | 8 | 24 | 168 | -1;
      smsAvailable?: boolean;
    }>('/firm/security-policy').catch(() => ({
      idleLockMinutes: 15,
      clientMessagingEnabled: true,
      firmName: 'Your Firm',
      stepupTimeoutHours: 24,
      smsAvailable: false,
    })),

  // Ask every other device of every member to re-run the rewrap sweep. Used
  // from the "Sync this device" button in the conversation banner when a
  // brand-new browser is missing its wrapped_keys entries.
  requestDeviceSync: () =>
    json<{ ok: true }>('/users/me/devices/request-sync', { method: 'POST' }),

  // Admin-only. Returns the encrypted firm recovery private key; the 24-word
  // phrase stays on the admin's device. Used to derive the firm private key
  // for emergency rewrap. Audit-logged on the server.
  getRecoveryRecord: () =>
    json<{
      publicKey: string;
      encryptedRecoveryPrivateKey: string;
      kdfSalt: string;
      kdfParams: { algorithm: string };
      rotationVersion: number;
    }>('/admin/firm/recovery-record'),

  enrollDevice: (body: {
    deviceId: string;
    publicKey: string;
    encryptedPrivateKey: string;
    kdfSalt: string;
    kdfParams: { opsLimit: number; memLimit: number; algorithm: 'argon2id13' };
    clientPlatform: 'tauri-win' | 'tauri-mac' | 'tauri-linux' | 'pwa' | 'web';
    clientVersion: string;
  }) =>
    json<{ ok: true; id: string; keyVersion: number }>('/users/me/devices', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listMyDevices: () =>
    json<{
      devices: Array<{
        id: string;
        deviceId: string;
        publicKey: string;
        keyVersion: number;
        clientPlatform: string;
        clientVersion: string | null;
        lastHeartbeatAt: string | null;
        createdAt: string;
        revokedAt: string | null;
      }>;
    }>('/users/me/devices'),

  getUserDeviceKeys: (userIds: string[]) =>
    json<{
      keys: Record<string, Array<{ deviceId: string; publicKey: string; keyVersion: number }>>;
    }>(`/users/keys?ids=${encodeURIComponent(userIds.join(','))}`),

  listProviderSecrets: () =>
    json<{
      items: Array<{
        key: string;
        configured: boolean;
        last4: string | null;
        updatedAt: string | null;
        updatedByUserId: string | null;
        masked: boolean;
      }>;
      knownKeys: string[];
    }>('/admin/providers'),
  setProviderSecret: (key: string, value: string) =>
    json<{
      meta: {
        key: string;
        configured: boolean;
        last4: string | null;
        updatedAt: string | null;
        updatedByUserId: string | null;
        masked: boolean;
      };
    }>(`/admin/providers/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  getTlsStatus: () => json<TlsStatus>('/admin/tls/status'),
  requestTls: () =>
    json<{ ok: true; accepted: true }>('/admin/tls/request', { method: 'POST', body: '{}' }),
  renewTls: () =>
    json<{ ok: true; accepted: true }>('/admin/tls/renew', { method: 'POST', body: '{}' }),
  clearTls: () => json<{ ok: true }>('/admin/tls/config', { method: 'DELETE' }),

  clearProviderSecret: (key: string) =>
    json<{
      meta: {
        key: string;
        configured: boolean;
        last4: string | null;
        updatedAt: string | null;
        updatedByUserId: string | null;
        masked: boolean;
      };
    }>(`/admin/providers/${encodeURIComponent(key)}`, { method: 'DELETE' }),

  reinviteClient: (id: string, via?: 'email' | 'sms') =>
    json<{ ok: true; invitePublicKey: string; inviteSent: boolean; sendError?: string }>(
      `/admin/clients/${id}/reinvite`,
      { method: 'POST', body: JSON.stringify(via ? { via } : {}) },
    ),

  // Staff-facing: list clients (external identities) reachable from this appliance
  // — either with a live invite public key or an active portal session. Used by
  // the Sidebar Clients group and the startConversation external path.
  listClients: () =>
    json<{
      clients: Array<{
        id: string;
        displayName: string;
        email: string | null;
        phone: string | null;
        firmClientRef: string | null;
        lastActiveAt: string | null;
        invitePublicKey: string | null;
        invitedAt: string | null;
        invitedVia: 'email' | 'sms' | null;
        verificationType: 'ssn' | 'ein' | 'none';
        reverifyEveryHours?: 4 | 8 | 24 | 168 | null;
        emailNotifications?: boolean;
        smsNotifications?: boolean;
        activeSessions: number;
      }>;
    }>('/clients'),
  getClientSessionKeys: (id: string) =>
    json<{
      invitePublicKey: string | null;
      sessions: Array<{ id: string; publicKey: string }>;
    }>(`/clients/${id}/session-keys`),

  // Staff-facing "Invite a client" — creates an external_identity, sends the
  // invite email/SMS, and returns the invite public key so the caller can
  // immediately wrap a fresh conversation key to it.
  inviteClient: (body: InviteClientRequest) =>
    json<InviteClientResponse>('/clients/invite', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Staff-facing "Resend invite" for a pending (not-yet-activated) client.
  // Accepts the same rich body as inviteClient so staff can fix typos in
  // name / email / phone / verification before re-sending. Rotates the
  // invite token + public key server-side.
  resendClientInvite: (id: string, body: InviteClientRequest) =>
    json<InviteClientResponse>(`/clients/${encodeURIComponent(id)}/reinvite`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  uploadAttachment: async (
    conversationId: string,
    body: {
      messageId: string;
      filenameCiphertext: string;
      wrappedFileKey: string;
      mimeType: string;
      ciphertext: Blob;
    },
  ): Promise<{
    id: string;
    storagePath: string;
    sizeBytes: number;
    scanStatus: 'clean' | 'infected';
  }> => {
    const form = new FormData();
    form.set('file', new File([body.ciphertext], 'blob', { type: body.mimeType }));
    form.set('messageId', body.messageId);
    form.set('filenameCiphertext', body.filenameCiphertext);
    form.set('wrappedFileKey', body.wrappedFileKey);
    const res = await fetch(`/conversations/${conversationId}/attachments`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!res.ok) {
      let err: { error?: string; signature?: string } = {};
      try {
        err = (await res.json()) as typeof err;
      } catch {
        /* non-JSON body */
      }
      const message =
        err.error === 'infected'
          ? `infected${err.signature ? `: ${err.signature}` : ''}`
          : `upload_failed_${res.status}`;
      throw Object.assign(new Error(message), { status: res.status, ...err });
    }
    return (await res.json()) as {
      id: string;
      storagePath: string;
      sizeBytes: number;
      scanStatus: 'clean' | 'infected';
    };
  },

  downloadAttachment: async (attachmentId: string): Promise<ArrayBuffer> => {
    const res = await fetch(`/conversations/attachments/${attachmentId}`, {
      credentials: 'include',
    });
    if (!res.ok) {
      throw new Error(`download_failed_${res.status}`);
    }
    return res.arrayBuffer();
  },
};

export type { DecryptedMessage };
