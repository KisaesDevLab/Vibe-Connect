// Phase 3 — Performance benchmark. Target: ≤10 ms per message on NucBox M6-class hardware.
// Run: yarn workspace @vibe-connect/crypto bench
//
// Measures: conversation-key unwrap + XChaCha20-Poly1305 decrypt of a ~1KB body per message.
import { generateKeypair } from './asymmetric.js';
import { createConversationKey, unwrapConversationKey } from './conversation.js';
import { encryptMessage, decryptMessage } from './symmetric.js';
import { utf8Encode } from './encoding.js';
import { ready } from './sodium.js';

async function main(): Promise<void> {
  await ready();
  const recipient = await generateKeypair();
  const { bundle, wrappedKeys } = await createConversationKey([
    { id: 'r1', publicKey: recipient.publicKey },
  ]);

  const body = utf8Encode('x'.repeat(1024));
  const env = await encryptMessage(body, bundle.key, 1);

  const N = 500;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const key = await unwrapConversationKey(
      wrappedKeys,
      'r1',
      recipient.publicKey,
      recipient.secretKey,
    );
    await decryptMessage(env, key);
  }
  const elapsed = performance.now() - t0;
  const per = elapsed / N;
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      runs: N,
      total_ms: +elapsed.toFixed(2),
      per_message_ms: +per.toFixed(3),
      target_ms: 10,
      ok: per <= 10,
    }),
  );
  if (per > 10) process.exit(1);
}

void main();
