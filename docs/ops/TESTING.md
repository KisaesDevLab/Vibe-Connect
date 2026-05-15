# Testing — server suite

## Quick reference

| Command | What it does |
| --- | --- |
| `yarn test` | Runs the whole server test suite. Routes through a sharded runner (`apps/server/scripts/test-sharded.mjs`) that handles a Windows-specific flake. |
| `yarn workspace @vibe-connect/server test:single` | Direct `vitest run`, no sharding, no retry. Faster (~2-3 min single Node process). Use on macOS/Linux CI where the Windows flake doesn't apply. |
| `yarn workspace @vibe-connect/server test:shard1` | Run the first half of the suite only. |
| `yarn workspace @vibe-connect/server test:shard2` | Second half. |
| `yarn workspace @vibe-connect/server test:watch` | Vitest watch mode. |

## The Windows worker-exit flake

When `yarn test` runs the whole server suite in a single Node process on Windows, the worker process intermittently dies with `STATUS_STACK_BUFFER_OVERRUN` (exit code `3221226505` / `0xC0000409`). Vitest reports it as `Error: Worker exited unexpectedly` with no stack trace from the worker.

### What we know

- Reproduces at roughly 30% per `yarn test` invocation, regardless of pool (`forks` vs `threads`), heap size, or shard count.
- Crash position is random — sometimes after the first test file, sometimes after the 30th. Not heap-size dependent.
- Does NOT reproduce on macOS or Linux CI. Windows-only.
- All test files pass cleanly when the run completes (282 tests, 0 failures).
- Likely caused by `libsodium-wrappers-sumo` (WASM) + `node-postgres` native bindings under Windows /GS protection, possibly aggravated by Windows Defender real-time scanning of the test process. Same suite has been stable on macOS/Linux for months.

### How `yarn test` handles it

`apps/server/scripts/test-sharded.mjs`:

1. Splits the suite into two vitest invocations via `--shard=1/2` and `--shard=2/2`. Each shard is a fresh Node process.
2. If a shard exits non-zero, retries it up to 2 times. Genuine test failures reproduce on retry (harmless — you see the failure twice); the Windows crash does not.
3. Probability of all 3 sequential invocations crashing on the same shard ≈ `0.3³ ≈ 3%` → the practical green-rate of `yarn test` is around 95-97%.

If `yarn test` does fail after retries, the failure is almost certainly a real test issue, not the flake.

### When you actually need to fix it

- Operator running `yarn test` repeatedly and the suite never goes green after retries → flag for re-investigation. Real test failures look the same as the flake from the parent process, so eyeball the in-shard output to see which test file's `✗` symbol appears.
- Adding new test files: prefer keeping individual files under ~10 tests where practical so a future need to shard further is mechanical.
- Significant `libsodium` upgrade or `node-postgres` major version bump: the flake's root cause is in the interaction of these native modules with Windows. A version bump may move the failure mode; re-baseline reproduction rate after the bump.

### What we tried that didn't help

- Switching `pool: 'forks'` → `pool: 'threads'`: no change (V8 heap shared across files made it slightly worse).
- Per-file isolation (`singleFork: false, isolate: true, maxForks: 1`): broke DB fixture sharing (21 of 32 files failed with `username='kurt'` duplicate-key collisions). Tests assume DB persists across files within a vitest invocation.
- `--max-old-space-size=4096` on the test forks: no measurable effect.
- `LOG_LEVEL=warn` during tests: dropped stdout volume by ~80% but the crash position remained random — log volume isn't the root cause.

## DB lifecycle

Tests share a single `vibe_connect_test` Postgres database (port 5435 by default — see `vitest.config.ts`). Each test file's `beforeAll` calls `resetTestDb()` (`apps/server/src/__tests__/test-helpers.ts`) which:

1. Rolls back every migration.
2. Re-applies every migration.
3. Re-runs seeds.

This is slow (~3-5s per file) but guarantees a clean slate. Within a file, individual tests share state — use `beforeEach` for per-test setup only when truly needed.

## Adding a new test file

1. `import { resetTestDb } from './test-helpers.js';` and call it from `beforeAll`.
2. Name the file `something.test.ts` under `apps/server/src/__tests__/` (or `apps/server/src/<module>/__tests__/` for module-local tests — see `apps/server/src/db/__tests__/schema.integrity.test.ts`).
3. Use Vitest's `describe`/`it` from the `vitest` import — don't enable `globals: true`.
4. For integration tests that need an external service (e.g. real ClamAV), gate on a dedicated env var via `describe.skipIf` so the default `yarn test` run stays green without the service. See `clamav-eicar.test.ts` for the pattern.
