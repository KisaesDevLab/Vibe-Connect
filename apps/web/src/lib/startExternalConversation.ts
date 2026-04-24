// Creates a new external (staff ↔ client) conversation: builds a fresh
// conversation key, wraps it to every staff device + the client's active
// portal sessions (or their one-time invite public key if they haven't
// logged in yet) + the firm recovery key, then POSTs to /conversations.
//
// CRYPTO: firm-recovery key is included in every conversation per the
// firm-recoverable trust model — without it, an admin who has lost every
// device cannot recover plaintext even with the 24-word phrase.
//
// Shared between Sidebar (clicking an existing client row) and the
// Invite-a-client modal (creating a brand-new client), which passes in
// the invitePublicKey it just received from POST /clients/invite so we
// don't have to round-trip through GET /clients/:id/session-keys.
import type { PublicUser } from '@vibe-connect/shared-types';
import { api } from '../api.js';

export const FIRM_RECIPIENT_ID = 'firm:recovery';

export type BuildConversationKey = (
  recipients: { id: string; publicKey: string }[],
) => Promise<{ key: Uint8Array; wrappedKeys: Record<string, string>; rotationVersion: number }>;

export interface ExternalConversationClient {
  id: string;
  displayName: string;
  /** Pre-known invite key (skip the session-keys fetch). Used right after POST /clients/invite. */
  invitePublicKey?: string;
}

export async function startExternalConversation(
  me: PublicUser,
  client: ExternalConversationClient,
  buildKey: BuildConversationKey,
): Promise<string> {
  const { keys } = await api.getUserDeviceKeys([me.id]);
  const staffDevices = keys[me.id] ?? [];
  if (staffDevices.length === 0) {
    throw new Error(
      `Your account has no enrolled device yet — finish the enrollment step on this browser first.`,
    );
  }

  const recipients: { id: string; publicKey: string }[] = staffDevices.map((d) => ({
    id: `${me.id}:${d.deviceId}`,
    publicKey: d.publicKey,
  }));

  // Pre-known invite key path: just-invited client, no portal sessions possible yet.
  if (client.invitePublicKey) {
    recipients.push({ id: `client:${client.id}:invite`, publicKey: client.invitePublicKey });
  } else {
    // Existing client path: fetch whatever session / invite keys the server currently has.
    const clientKeys = await api.getClientSessionKeys(client.id);
    if (clientKeys.sessions.length > 0) {
      for (const s of clientKeys.sessions) {
        recipients.push({ id: `client:${client.id}:session:${s.id}`, publicKey: s.publicKey });
      }
    } else if (clientKeys.invitePublicKey) {
      recipients.push({
        id: `client:${client.id}:invite`,
        publicKey: clientKeys.invitePublicKey,
      });
    } else {
      throw new Error(
        `${client.displayName} hasn't accepted the invite and has no pending invite key. Ask an admin to send a fresh invite, then try again.`,
      );
    }
  }

  const firmKey = await api.getFirmPublicKey();
  if (firmKey?.publicKey) {
    recipients.push({ id: FIRM_RECIPIENT_ID, publicKey: firmKey.publicKey });
  }

  const { wrappedKeys, rotationVersion } = await buildKey(recipients);
  const created = await api.createConversation({
    type: 'external',
    memberUserIds: [me.id],
    memberExternalIdentityIds: [client.id],
    displayName: client.displayName,
    wrappedKeys,
    rotationVersion,
  });
  return created.id;
}
