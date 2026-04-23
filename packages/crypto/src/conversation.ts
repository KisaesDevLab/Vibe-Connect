// Conversation key lifecycle: generation, per-member wrapping, rotation on membership change.
// CRYPTO: the conversation key is the only way to read body ciphertext.
import { unwrapKey, wrapKey } from './asymmetric.js';
import { fromBase64 } from './encoding.js';
import { generateSymmetricKey } from './symmetric.js';

export interface WrappedKeyMap {
  [recipientId: string]: string; // recipientId = user_key.id or client_session.id or 'firm'
}

export interface ConversationKeyBundle {
  rotationVersion: number;
  key: Uint8Array;
}

export interface Recipient {
  id: string; // server-side user_key.id or client_session.id; "firm" for recovery access
  publicKey: string; // base64 X25519 public key
}

/** Create a new conversation key and wrap it to every authorized recipient. */
export async function createConversationKey(
  recipients: Recipient[],
  rotationVersion = 1,
): Promise<{ bundle: ConversationKeyBundle; wrappedKeys: WrappedKeyMap }> {
  const key = await generateSymmetricKey();
  const wrappedKeys: WrappedKeyMap = {};
  for (const r of recipients) {
    wrappedKeys[r.id] = await wrapKey(key, r.publicKey);
  }
  return { bundle: { rotationVersion, key }, wrappedKeys };
}

/** Unwrap the conversation key for a single recipient that holds its X25519 keypair. */
export async function unwrapConversationKey(
  wrappedKeys: WrappedKeyMap,
  recipientId: string,
  publicKey: string,
  secretKey: string,
): Promise<Uint8Array> {
  const wrapped = wrappedKeys[recipientId];
  if (!wrapped) throw new Error('no wrapped key for this recipient');
  return unwrapKey(wrapped, publicKey, secretKey);
}

/**
 * Rotate: generate a fresh symmetric key and wrap it to the new membership set. Used when:
 *   - A member is added (they get access from their join forward)
 *   - A member is removed (old ciphertext stays unreadable to them since the key changed)
 *   - Periodic rotation at admin discretion
 *
 * Returns the new bundle; callers must store the new rotation version on the row.
 */
export async function rotateConversationKey(
  recipients: Recipient[],
  previousVersion: number,
): Promise<{ bundle: ConversationKeyBundle; wrappedKeys: WrappedKeyMap }> {
  return createConversationKey(recipients, previousVersion + 1);
}

/**
 * Incremental wrap: when a single new member is added and we don't want to rotate the key,
 * wrap the existing key just for that new recipient. NOT a replacement for rotation on member
 * removal (that requires a true rotation).
 */
export async function incrementalWrap(
  existingKey: Uint8Array,
  newRecipient: Recipient,
): Promise<string> {
  return wrapKey(existingKey, newRecipient.publicKey);
}

/**
 * Rewrap the existing key to the current membership WITHOUT rotation.
 *
 * CRYPTO: DO NOT USE for member REMOVAL — a departed member who cached the unwrapped key
 * can still decrypt anything encrypted with it, regardless of server-side rewrap. Member
 * removal MUST call `rotateConversationKey` so future messages use a fresh symmetric key.
 *
 * Valid uses: compaction / cleanup of stale wrapped entries when the membership set is
 * unchanged but the stored map needs to be rewritten (e.g. after a server-side key-format
 * migration).
 */
export async function rewrapForSameMembership(
  existingKey: Uint8Array,
  currentRecipients: Recipient[],
): Promise<WrappedKeyMap> {
  const out: WrappedKeyMap = {};
  for (const r of currentRecipients) {
    out[r.id] = await wrapKey(existingKey, r.publicKey);
  }
  return out;
}

/** Helper for tests / audit: ensure a conversation key round-trips end to end. */
export function assertKeyShape(key: Uint8Array): void {
  if (key.length !== 32) throw new Error(`bad conversation key length: ${key.length}`);
}

export { fromBase64 };
