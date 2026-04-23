// Admin-initiated "decrypt conversation for audit" flow.
// CRYPTO: requires the recovery phrase; never runs without an audit-log entry.
import { unwrapKey } from './asymmetric.js';
import { fromBase64 } from './encoding.js';
import type { FirmKeyRecord } from './firm.js';
import { recoverFirmPrivateKey } from './firm.js';
import { decryptMessage, type SymmetricEnvelope } from './symmetric.js';

/**
 * Unwrap the conversation key using the firm master key (stored in the "firm" slot of
 * `conversation_keys.wrapped_keys`). The caller must supply the recovery phrase.
 */
export async function emergencyUnwrapConversationKey(
  firmKey: FirmKeyRecord,
  recoveryPhrase: string[],
  wrappedForFirm: string,
): Promise<Uint8Array> {
  const firmSecretKey = await recoverFirmPrivateKey(firmKey, recoveryPhrase);
  return unwrapKey(wrappedForFirm, firmKey.publicKey, firmSecretKey);
}

/**
 * Decrypt a batch of messages for audit/export. Caller is responsible for the audit-log entry
 * BEFORE invoking this function.
 */
export async function emergencyDecryptMessages(
  conversationKey: Uint8Array,
  messages: { id: string; envelope: SymmetricEnvelope; associatedData?: Uint8Array }[],
): Promise<{ id: string; plaintext: Uint8Array }[]> {
  const out: { id: string; plaintext: Uint8Array }[] = [];
  for (const m of messages) {
    const plaintext = await decryptMessage(m.envelope, conversationKey, m.associatedData);
    out.push({ id: m.id, plaintext });
  }
  return out;
}

export { fromBase64 };
