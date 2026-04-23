// CRYPTO: enforces the ≤10ms per-message target from Phase 3.
import { describe, expect, it } from 'vitest';
import { generateKeypair } from '../asymmetric.js';
import { createConversationKey, unwrapConversationKey } from '../conversation.js';
import { decryptMessage, encryptMessage } from '../symmetric.js';
import { ready } from '../sodium.js';

await ready();

describe('benchmark', () => {
  it('unwrap + decrypt averages ≤10ms/msg across 200 iterations', async () => {
    const recipient = await generateKeypair();
    const { bundle, wrappedKeys } = await createConversationKey([
      { id: 'r1', publicKey: recipient.publicKey },
    ]);
    const env = await encryptMessage(new Uint8Array(1024), bundle.key, 1);

    const N = 200;
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
    const per = (performance.now() - t0) / N;
    expect(per, `avg ${per.toFixed(3)}ms/msg should be ≤10ms`).toBeLessThanOrEqual(10);
  });
});
