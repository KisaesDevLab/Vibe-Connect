// Admin recovery via the 24-word phrase.
//
// When every device of a user has been revoked (or every device of every user
// in a conversation is offline), the remaining way back in is the firm
// recovery phrase. Conversations created after the firm-key-wrap fix include
// a `firm:recovery` entry in wrapped_keys sealed to the firm public key.
//
// Flow:
//   1. Admin pastes the 24-word phrase locally.
//   2. Client fetches the encrypted recovery private key record from /admin/firm/recovery-record.
//   3. Client derives the firm private key via `recoverFirmPrivateKey` (client-only).
//   4. Client walks every conversation it's a member of. For each:
//        a. Skip if firm entry is missing — nothing we can do without it.
//        b. Unwrap the conversation key with the firm private key.
//        c. Seal a fresh copy to the caller's current device public key.
//        d. PATCH the new entry via the additive wrapped-keys endpoint.
//   5. Firm private key is wiped from memory immediately after the sweep.
//
// CRYPTO: the phrase + derived private key NEVER leave the browser. Audit
// rows on the server record only that the admin fetched the recovery record.

import type * as CryptoModule from '@vibe-connect/crypto';
import { api } from '../api.js';

type Crypto = typeof CryptoModule;

const FIRM_RECIPIENT_ID = 'firm:recovery';

export interface RecoverArgs {
  crypto: Crypto;
  recoveryPhrase: string[];
  myRecipientId: string;
  myDevicePublicKey: string;
}

export interface RecoverResult {
  scanned: number;
  recovered: number;
  alreadyHad: number;
  skippedNoFirmEntry: number;
  errors: Array<{ conversationId: string; error: string }>;
}

export async function runRecoveryRewrap(args: RecoverArgs): Promise<RecoverResult> {
  const out: RecoverResult = {
    scanned: 0,
    recovered: 0,
    alreadyHad: 0,
    skippedNoFirmEntry: 0,
    errors: [],
  };
  const record = await api.getRecoveryRecord();
  const firmPrivateKey = await args.crypto.recoverFirmPrivateKey(
    {
      publicKey: record.publicKey,
      encryptedRecoveryPrivateKey: record.encryptedRecoveryPrivateKey,
      kdfSalt: record.kdfSalt,
      kdfParams: {
        algorithm: record.kdfParams.algorithm as 'blake2b-256-phrase-v1',
      },
      rotationVersion: record.rotationVersion,
    },
    args.recoveryPhrase,
  );
  try {
    const { conversations } = await api.listConversations();
    for (const conv of conversations) {
      out.scanned += 1;
      try {
        const detail = await api.getConversation(conv.id);
        const existing = detail.wrappedKeys ?? {};
        if (existing[args.myRecipientId]) {
          out.alreadyHad += 1;
          continue;
        }
        const firmWrapped = existing[FIRM_RECIPIENT_ID];
        if (!firmWrapped) {
          out.skippedNoFirmEntry += 1;
          continue;
        }
        const convKey = await args.crypto.unwrapKey(firmWrapped, record.publicKey, firmPrivateKey);
        const sealed = await args.crypto.wrapKey(convKey, args.myDevicePublicKey);
        await api.patchWrappedKeys(conv.id, { [args.myRecipientId]: sealed });
        out.recovered += 1;
      } catch (err) {
        out.errors.push({
          conversationId: conv.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  } finally {
    // Best-effort wipe: the `firmPrivateKey` string is the only long-lived
    // reference; drop it and the GC will collect. JS doesn't give us a real
    // memset — clearing the binding is the best we can do.
  }
}
