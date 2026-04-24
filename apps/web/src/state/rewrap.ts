// Multi-device conversation key sync.
//
// Problem: when a user enrolls a new device (second browser, new workstation),
// its public key is NOT in the wrapped_keys of any existing conversation. The
// server can't rewrap — it never sees the conversation key. So the new device
// can't decrypt history.
//
// Fix: any already-enrolled, unlocked device of a conversation member walks the
// list of conversations it can read, sees which recipients (own devices + other
// members' devices) are missing a wrapped-key entry, seals a copy of the
// conversation key to each missing recipient's public key, and PATCHes the
// delta in via the additive-only endpoint.
//
// CRYPTO: this touches the unwrapped conversation key in memory. It runs only
// while the device is unlocked (getSecretKey() returns non-null) and discards
// everything when it completes.

import type * as CryptoModule from '@vibe-connect/crypto';
import { api } from '../api.js';

type Crypto = typeof CryptoModule;

interface RunArgs {
  crypto: Crypto;
  /** Staff recipient id for the caller's own device — `${userId}:${deviceId}`. */
  myRecipientId: string;
  myDevicePublicKey: string;
  myDeviceSecretKey: string;
  /** Hard cap on conversations scanned per sweep. */
  limit?: number;
}

const FIRM_RECIPIENT_ID = 'firm:recovery';

export interface SweepResult {
  scanned: number;
  patched: number;
  addedEntries: number;
  errors: number;
}

let running = false;
let lastRunAt = 0;
// Short cooldown between completed sweeps. Long enough to coalesce a flood of
// device:enrolled events; short enough that a "mount" sweep followed 2s later
// by a "push" sweep still actually runs. The `running` guard below stops
// concurrent invocations entirely, so this only governs consecutive ones.
const MIN_INTERVAL_MS = 2_000;

/**
 * Run one sweep. Safe to call on startup, socket reconnect, or periodically —
 * idempotent + rate-limited so overlapping triggers coalesce.
 */
export async function runDeviceRewrapSweep(args: RunArgs): Promise<SweepResult> {
  const out: SweepResult = { scanned: 0, patched: 0, addedEntries: 0, errors: 0 };
  const now = Date.now();
  if (running || now - lastRunAt < MIN_INTERVAL_MS) return out;
  running = true;
  lastRunAt = now;
  try {
    const { conversations } = await api.listConversations();
    if (conversations.length === 0) return out;
    const limit = args.limit ?? 200;

    // Pull every member userId across the caller's conversations in one batch
    // so we know their active device keys without N queries.
    const memberUserIds = new Set<string>();
    for (const c of conversations) for (const uid of c.memberUserIds) memberUserIds.add(uid);
    const keysByUser = memberUserIds.size
      ? (await api.getUserDeviceKeys([...memberUserIds])).keys
      : {};

    // Firm public key — used to back-fill the firm-recovery wrap in every
    // conversation that's missing it. Cached once per sweep.
    const firmKey = await api.getFirmPublicKey().catch(() => null);

    const slice = conversations.slice(0, limit);
    for (const conv of slice) {
      try {
        out.scanned += 1;
        // Fetch the full conversation detail — we need wrappedKeys. The summary
        // omits them to keep the list payload small.
        const detail = await api.getConversation(conv.id);
        if (!detail.wrappedKeys) continue;
        const existingKeys = detail.wrappedKeys;
        if (!(args.myRecipientId in existingKeys)) {
          // I can't rewrap if the conversation key wasn't even sealed to me —
          // that's a different gap (e.g. a conversation my other device started
          // hasn't rewrapped to ME yet). Skip; whichever device CAN unwrap will
          // pick it up on its own sweep.
          continue;
        }
        const missing: Record<string, string> = {};
        // Staff device recipients: each member's active user_keys not in wrappedKeys.
        for (const uid of conv.memberUserIds) {
          const devs = keysByUser[uid] ?? [];
          for (const d of devs) {
            const rid = `${uid}:${d.deviceId}`;
            if (existingKeys[rid]) continue;
            // We won't have sealed the key ourselves — acquire it lazily below.
            missing[rid] = d.publicKey;
          }
        }
        // Firm recovery key: if it's missing, back-fill so an admin with the
        // 24-word phrase can recover this conversation later.
        if (firmKey?.publicKey && !existingKeys[FIRM_RECIPIENT_ID]) {
          missing[FIRM_RECIPIENT_ID] = firmKey.publicKey;
        }
        // External (portal) recipients: active session keys for each client member.
        for (const xid of conv.memberExternalIdentityIds ?? []) {
          let clientKeys;
          try {
            clientKeys = await api.getClientSessionKeys(xid);
          } catch {
            continue;
          }
          for (const s of clientKeys.sessions) {
            const rid = `client:${xid}:session:${s.id}`;
            if (existingKeys[rid]) continue;
            missing[rid] = s.publicKey;
          }
          // The invite public key, if present, should also be wrapped — but
          // createConversation will have already wrapped it at creation time, so
          // this handles the rare case of a reinvite that rotated the key.
          if (clientKeys.invitePublicKey) {
            const rid = `client:${xid}:invite`;
            if (!existingKeys[rid]) missing[rid] = clientKeys.invitePublicKey;
          }
        }
        if (Object.keys(missing).length === 0) continue;

        // Unwrap the conversation key once, seal once per missing recipient.
        const convKey = await args.crypto.unwrapKey(
          existingKeys[args.myRecipientId]!,
          args.myDevicePublicKey,
          args.myDeviceSecretKey,
        );
        const added: Record<string, string> = {};
        for (const [rid, pubKey] of Object.entries(missing)) {
          try {
            added[rid] = await args.crypto.wrapKey(convKey, pubKey);
          } catch {
            out.errors += 1;
          }
        }
        if (Object.keys(added).length === 0) continue;
        await api.patchWrappedKeys(conv.id, added);
        out.patched += 1;
        out.addedEntries += Object.keys(added).length;
      } catch {
        out.errors += 1;
      }
    }
    return out;
  } finally {
    running = false;
  }
}
