// Thin JSON + form fetch wrappers. Always include credentials so the session cookie flows.
import { url } from './lib/boot.js';
import type {
  ClientVault,
  ConversationSummary,
  CreateRequestItemBody,
  CreateRequestListBody,
  CreateRequestTemplateBody,
  DecryptedMessage,
  EncryptedMessage,
  FirmPublicKey,
  Group,
  InviteClientRequest,
  InviteClientResponse,
  PatchRequestItemBody,
  PatchRequestListBody,
  PatchRequestTemplateBody,
  PublicUser,
  RequestDashboardRow,
  RequestItem,
  RequestList,
  RequestListWithItems,
  RequestTemplate,
  TlsStatus,
  VaultFile,
  VaultFolder,
  VaultKeyBundle,
  VaultZone,
} from '@vibe-connect/shared-types';

// Distribution mode: `url()` prepends BASE_PATH so the same code runs under
// both single-app ('/') and multi-app ('/connect/') prefixes. Single-app
// passes through verbatim. Vite dev proxy still works because the proxy
// matches paths after the prefix is stripped (single-app keeps the prefix
// empty so nothing changes for daily `yarn dev`).
async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url(input), {
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
    const r = await fetch(url('/users/me/avatar'), {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!r.ok) throw new Error(`avatar_upload_${r.status}`);
    return (await r.json()) as { avatarUrl: string };
  },
  me: () => json<{ user: PublicUser }>('/auth/me'),
  // Self-service profile patch. Either field can be `null` to clear, or
  // omitted to leave alone. Server normalizes phone to E.164.
  updateMe: (patch: { email?: string | null; phone?: string | null }) =>
    json<{ user: PublicUser }>('/auth/me', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
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
      /** Phase 27: optional self-destruct timer (seconds after first non-sender read). */
      destructAfterViewSeconds?: number | null;
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
      requestsEnabled?: boolean;
      vaultEnabled?: boolean;
      firmName?: string;
      appName?: string | null;
      stepupTimeoutHours?: 4 | 8 | 24 | 168 | -1;
      smsAvailable?: boolean;
      messageEditWindowMinutes?: number;
      messageDestructEnabled?: boolean;
      messageDestructMaxSeconds?: number;
    }>('/firm/security-policy').catch(() => ({
      idleLockMinutes: 15,
      clientMessagingEnabled: true,
      requestsEnabled: true,
      vaultEnabled: true,
      firmName: 'Your Firm',
      appName: null,
      stepupTimeoutHours: 24,
      smsAvailable: false,
      messageEditWindowMinutes: 15,
      messageDestructEnabled: true,
      messageDestructMaxSeconds: 604800,
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

  // Phase 24: Client Requests & Document Collection. Item titles +
  // descriptions + revision notes are E2EE under the conversation's content
  // key — callers must encrypt before passing them through these helpers.
  // List titles are cleartext.
  requests: {
    listForConversation: (conversationId: string) =>
      json<{ lists: RequestList[] }>(
        `/conversations/${encodeURIComponent(conversationId)}/request-lists`,
      ),
    createList: (conversationId: string, body: CreateRequestListBody) =>
      json<{ list: RequestListWithItems }>(
        `/conversations/${encodeURIComponent(conversationId)}/request-lists`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    getList: (id: string) =>
      json<{ list: RequestListWithItems }>(`/request-lists/${encodeURIComponent(id)}`),
    patchList: (id: string, body: PatchRequestListBody) =>
      json<{ list: RequestList }>(`/request-lists/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    cancelList: (id: string) =>
      json<{ list: RequestList }>(`/request-lists/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    addItem: (listId: string, body: CreateRequestItemBody) =>
      json<{ item: RequestItem }>(`/request-lists/${encodeURIComponent(listId)}/items`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    patchItem: (id: string, body: PatchRequestItemBody) =>
      json<{ item: RequestItem }>(`/request-items/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    deleteItem: (id: string) =>
      fetch(url(`/request-items/${encodeURIComponent(id)}`), {
        method: 'DELETE',
        credentials: 'include',
      }).then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
      }),
    markDone: (id: string) =>
      json<{ item: RequestItem; listCompleted: boolean }>(
        `/request-items/${encodeURIComponent(id)}/mark-done`,
        { method: 'POST', body: '{}' },
      ),
    requestRevision: (
      id: string,
      body: { noteCiphertext: string; contentKeyVersion: number },
    ) =>
      json<{ item: RequestItem }>(
        `/request-items/${encodeURIComponent(id)}/request-revision`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    linkMessage: (id: string, messageId: string) =>
      json<{ ok: true }>(`/request-items/${encodeURIComponent(id)}/link-message`, {
        method: 'POST',
        body: JSON.stringify({ messageId }),
      }),
    listTemplates: () => json<{ templates: RequestTemplate[] }>('/request-templates'),
    createTemplate: (body: CreateRequestTemplateBody) =>
      json<{ template: RequestTemplate }>('/request-templates', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    patchTemplate: (id: string, body: PatchRequestTemplateBody) =>
      json<{ template: RequestTemplate }>(`/request-templates/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    archiveTemplate: (id: string) =>
      json<{ template: RequestTemplate }>(`/request-templates/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    dashboard: () => json<{ rows: RequestDashboardRow[] }>('/requests/dashboard'),
    nudge: (
      listId: string,
      body: {
        sendAt?: string | null;
        channel: 'inapp' | 'email' | 'sms' | 'all';
        customBody?: string | null;
      },
    ) =>
      json<{ messageId: string }>(
        `/request-lists/${encodeURIComponent(listId)}/nudge`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
  },

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
    const res = await fetch(url(`/conversations/${conversationId}/attachments`), {
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
    const res = await fetch(url(`/conversations/attachments/${attachmentId}`), {
      credentials: 'include',
    });
    if (!res.ok) {
      throw new Error(`download_failed_${res.status}`);
    }
    return res.arrayBuffer();
  },

  getVaultTemplates: () =>
    json<{
      templates: Array<{
        nameTemplate: string;
        zone: 'shared' | 'staff_only';
        retentionDays: number | null;
      }>;
    }>('/firm/vault-templates').catch(() => ({ templates: [] })),

  // ---------- Phase 26 — Client Vault ----------
  vault: {
    list: (externalIdentityId: string) =>
      json<{
        vault: ClientVault;
        folders: VaultFolder[];
        files: VaultFile[];
        keys: VaultKeyBundle[];
      }>(`/clients/${externalIdentityId}/vault`),
    createFolder: (
      externalIdentityId: string,
      body: {
        zone: VaultZone;
        parentFolderId?: string | null;
        nameCiphertext: string;
        contentKeyVersion: number;
        sortOrder?: number;
      },
    ) =>
      json<{ folder: VaultFolder }>(`/clients/${externalIdentityId}/vault/folders`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    patchFolder: (
      externalIdentityId: string,
      folderId: string,
      patch: {
        nameCiphertext?: string;
        contentKeyVersion?: number;
        sortOrder?: number;
        parentFolderId?: string | null;
      },
    ) =>
      json<{ folder: VaultFolder }>(`/clients/${externalIdentityId}/vault/folders/${folderId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    deleteFolder: (externalIdentityId: string, folderId: string) =>
      json<void>(`/clients/${externalIdentityId}/vault/folders/${folderId}`, { method: 'DELETE' }),
    patchFile: (
      externalIdentityId: string,
      fileId: string,
      patch: {
        filenameCiphertext?: string;
        contentKeyVersion?: number;
        folderId?: string | null;
        retentionExpiresAt?: string | null;
      },
    ) =>
      json<{ file: VaultFile }>(`/clients/${externalIdentityId}/vault/files/${fileId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    deleteFile: (externalIdentityId: string, fileId: string) =>
      json<void>(`/clients/${externalIdentityId}/vault/files/${fileId}`, { method: 'DELETE' }),
    download: async (externalIdentityId: string, fileId: string): Promise<ArrayBuffer> => {
      const res = await fetch(url(`/clients/${externalIdentityId}/vault/files/${fileId}`), {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`vault_download_failed_${res.status}`);
      return res.arrayBuffer();
    },
    rotateKeys: (
      externalIdentityId: string,
      body: { zone: VaultZone; rotationVersion: number; wrappedKeys: Record<string, string> },
    ) =>
      json<{ key: VaultKeyBundle }>(`/clients/${externalIdentityId}/vault/rotate-keys`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    addRecipients: (
      externalIdentityId: string,
      body: { zone: VaultZone; rotationVersion: number; added: Record<string, string> },
    ) =>
      json<{ added: string[] }>(`/clients/${externalIdentityId}/vault/recipients`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
};

export type { DecryptedMessage };
