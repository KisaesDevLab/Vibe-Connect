// BRIDGE: seal inbound gateway plaintext to the firm public key so the server never
// retains a readable copy. The only way to recover is via the recovery phrase
// (emergency_decrypt) OR a staff client rewrapping under the conversation key on first
// access. This keeps the CLAUDE.md "server stores ciphertext only" invariant intact —
// the plaintext window is bounded to the microseconds between webhook parse and the
// sealed-box wrap here.
//
// Envelope format (stored in messages.ciphertext, JSON-encoded):
//   { v: "bridge-sealed-v1", k: <base64 wrapped-to-firm symmetric key>,
//     e: { n, c, v } }  // standard SymmetricEnvelope
import { encryptWithFreshKey, wrapToFirm, type SymmetricEnvelope } from '@vibe-connect/crypto';
import { db } from '../db/knex.js';

export interface BridgeSealedEnvelope {
  v: 'bridge-sealed-v1';
  k: string;
  e: SymmetricEnvelope;
}

export async function sealPlaintextForBridge(plaintextUtf8: string): Promise<Buffer> {
  const firm = await db('firm_keys').whereNull('retired_at').first();
  if (!firm?.public_key) {
    throw new Error('bridge_seal_requires_firm_key_installed');
  }
  const { key, envelope } = await encryptWithFreshKey(Buffer.from(plaintextUtf8, 'utf8'));
  const wrapped = await wrapToFirm(key, firm.public_key);
  const sealed: BridgeSealedEnvelope = { v: 'bridge-sealed-v1', k: wrapped, e: envelope };
  return Buffer.from(JSON.stringify(sealed), 'utf8');
}
