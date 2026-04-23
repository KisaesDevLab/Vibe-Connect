// Thin JSON + form fetch wrappers. Always include credentials so the session cookie flows.
import type {
  ConversationSummary,
  DecryptedMessage,
  EncryptedMessage,
  FirmPublicKey,
  Group,
  PublicUser,
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
  me: () => json<{ user: PublicUser }>('/auth/me'),

  listUsers: () => json<{ users: PublicUser[] }>('/users'),
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
    }>(`/conversations/${id}`),
  createConversation: (body: {
    type: 'internal' | 'external';
    memberUserIds: string[];
    memberExternalIdentityIds?: string[];
    displayName?: string | null;
    wrappedKeys: Record<string, string>;
    rotationVersion?: number;
  }) => json<{ id: string }>('/conversations', { method: 'POST', body: JSON.stringify(body) }),

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
  ) =>
    json<{ id: string; createdAt: string; scheduledFor: string | null }>(
      `/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify(payload) },
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
  // TODO(phase11): serve this through an admin route that also exposes rotation metadata.
  getFirmPublicKey: () => json<FirmPublicKey | null>('/firm/public-key').catch(() => null),
};

export type { DecryptedMessage };
