import type {
  ClientVault,
  RequestList,
  RequestListWithItems,
  VaultFile,
  VaultFolder,
  VaultKeyBundle,
} from '@vibe-connect/shared-types';
import { url as buildUrl } from './lib/boot.js';

// Distribution mode: every fetch goes through `buildUrl()` so the same
// bundle works under '/' (single-app) and '/connect/' (multi-app) without
// rebuild. The local helper is named `buildUrl` to dodge the parameter
// shadow on the existing `json` wrapper.
async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(buildUrl(path), {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`${res.status}`), { status: res.status, body });
  }
  return (await res.json()) as T;
}

export const portalApi = {
  identify: (identifier: string) =>
    json<{ ok: true; sent: boolean; hint?: string }>('/portal/identify', {
      method: 'POST',
      body: JSON.stringify({ identifier }),
    }),
  verify: (identifier: string, code: string, sessionPublicKey: string) =>
    json<{
      ok: true;
      sessionId: string;
      verificationRequired: boolean;
      verificationType: 'ssn' | 'ein' | 'none';
    }>('/portal/verify', {
      method: 'POST',
      body: JSON.stringify({ identifier, code, sessionPublicKey }),
    }),
  stepup: (last4: string) =>
    json<{ ok: true; verifiedUntil: string | null }>('/portal/stepup', {
      method: 'POST',
      body: JSON.stringify({ last4 }),
    }),
  me: () =>
    json<{
      session: { id: string; verifiedUntil: string | null };
      identity: {
        id: string;
        displayName: string;
        email: string;
        phone: string | null;
        verificationRequired: boolean;
        verificationType: 'ssn' | 'ein' | 'none';
        hasVerification: boolean;
      } | null;
    }>('/portal/me'),
  logout: () => json<{ ok: true }>('/portal/logout', { method: 'POST' }),
  // Phase 24: Client Requests & Document Collection (portal side, read-only).
  // Item titles + descriptions + revision notes are E2EE under the
  // conversation's content key; the portal decrypts them client-side using
  // the same convKey it already unwraps for messages. Submitting a response
  // rides the existing /portal/conversations/:id/messages flow with
  // ciphertextMeta.requestItemId set — there's no dedicated submit endpoint.
  requests: {
    list: () => json<{ lists: RequestList[]; requestsDisabled?: boolean }>('/portal/request-lists'),
    get: (id: string) =>
      json<{ list: RequestListWithItems }>(`/portal/request-lists/${encodeURIComponent(id)}`),
  },
  // Phase 26: Client Vault — Shared zone only from the portal.
  vault: {
    list: () =>
      json<{
        vault: ClientVault | null;
        folders: VaultFolder[];
        files: VaultFile[];
        keys: VaultKeyBundle[];
        stepupRequired?: boolean;
        vaultDisabled?: boolean;
      }>('/portal/vault'),
    deleteFile: async (fileId: string): Promise<void> => {
      const res = await fetch(buildUrl(`/portal/vault/files/${encodeURIComponent(fileId)}`), {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`vault_delete_failed_${res.status}`);
    },
    download: async (fileId: string): Promise<ArrayBuffer> => {
      const res = await fetch(buildUrl(`/portal/vault/files/${encodeURIComponent(fileId)}`), {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`vault_download_failed_${res.status}`);
      return res.arrayBuffer();
    },
  },
};
