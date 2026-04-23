// Single libsodium instance; await `ready()` once before any primitive runs.
// CRYPTO: all sodium access goes through this module.
// We use the `-sumo` variant because we need Argon2id (crypto_pwhash) which is not in core.
//
// libsodium-wrappers-sumo ships a broken ESM entry point that imports a sibling `.mjs` that
// isn't in the published tarball. To stay portable across Node (tsx, jest, vitest) and browser
// bundlers (Vite), we load the CJS build in Node via createRequire, and let Vite resolve the
// package normally in the browser.
import type sodiumType from 'libsodium-wrappers-sumo';

let sodiumImpl: typeof sodiumType | undefined;
let readyPromise: Promise<typeof sodiumType> | null = null;

async function load(): Promise<typeof sodiumType> {
  if (sodiumImpl) return sodiumImpl;
  const isNode =
    typeof process !== 'undefined' &&
    process.versions !== null &&
    process.versions !== undefined &&
    process.versions.node !== null &&
    process.versions.node !== undefined;
  if (isNode) {
    // `eval('require')` returns Node's CommonJS `require`, which picks the "require"
    // subpath of libsodium-wrappers-sumo's exports — the CJS build — avoiding the broken
    // ESM entry. Bundlers do not statically analyse `eval`, so this stays a no-op in the
    // browser bundle.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-eval
    const nodeRequire = eval('require') as (id: string) => unknown;
    sodiumImpl = nodeRequire('libsodium-wrappers-sumo') as typeof sodiumType;
  } else {
    const mod = (await import('libsodium-wrappers-sumo')) as unknown as {
      default: typeof sodiumType;
    };
    sodiumImpl = mod.default ?? (mod as unknown as typeof sodiumType);
  }
  return sodiumImpl;
}

export async function ready(): Promise<typeof sodiumType> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const s = await load();
    await s.ready;
    return s;
  })();
  return readyPromise;
}

// A synchronous getter for modules that need the constants/functions directly. Only valid after
// `await ready()` has resolved at least once.
export function sodium(): typeof sodiumType {
  if (!sodiumImpl) {
    throw new Error('sodium accessed before ready() — call await ready() first');
  }
  return sodiumImpl;
}
