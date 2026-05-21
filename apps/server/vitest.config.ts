import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    globals: false,
    // Forks pool with singleFork: every test file shares one Node process.
    // Many test files seed a common fixture set (e.g. `username='kurt'`)
    // and assume the DB persists across files — per-file isolation
    // breaks that assumption with duplicate-key collisions. Threads pool
    // shares V8 heap which makes Windows /GS stack-overrun crashes
    // (exit 3221226505 / 0xC0000409) WORSE, not better.
    //
    // The remaining intermittent worker crash on Windows is documented in
    // docs/ops/TESTING.md — it's a libsodium-wrappers-sumo + node-postgres
    // long-running-process issue on Windows /GS, not a logic bug. The
    // workarounds applied here:
    //   1. LOG_LEVEL=warn during tests (cuts ~80% of stdout volume)
    //   2. --max-old-space-size=4096 (V8 heap headroom)
    //   3. process_node_options below propagates to child fork via POOL_OPTS
    //
    // If the suite still crashes after these, the next escalation is
    // splitting the suite into shards run in separate `yarn test` invocations
    // (a runtime change, not a config change).
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true, // DB state is shared — avoid parallel chaos
        execArgv: ['--max-old-space-size=4096'],
      },
    },
    env: {
      NODE_ENV: 'test',
      // Default LOG_LEVEL to 'warn' in tests so request-log spam stays out of
      // the way without losing genuine warnings/errors. Override per-test if a
      // suite needs info-level visibility.
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test',
      SESSION_SECRET: process.env.SESSION_SECRET ?? 'ci-session-secret-not-real',
      // Override the bundled EMAIL_FROM placeholder so the provider-boundary
      // sender-domain guard (bridges/email/index.ts assertEmailFromConfigured)
      // doesn't trip on the placeholder `vibeconnect.local` during tests that
      // exercise the real provider implementations with fetch mocked.
      EMAIL_FROM: process.env.EMAIL_FROM ?? 'Vibe Connect Test <test@example.com>',
      // Phase 28 — deterministic 32-byte intake key for tests so encryptField/
      // decryptField round-trips work and searchHash output is stable across
      // runs. NOT a production key; the test database is throwaway.
      CONNECT_INTAKE_ENCRYPTION_KEY:
        process.env.CONNECT_INTAKE_ENCRYPTION_KEY ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      RATE_LIMIT_LOGIN_PER_MIN: '10000',
      RATE_LIMIT_GLOBAL_PER_MIN: '100000',
      RATE_LIMIT_PORTAL_CODE_PER_10MIN: '10000',
      // High intake-session limit for the bulk of tests; the rate-limit-
      // specific test in intake-session-create.test.ts overrides this back
      // down to 5 for the burst-then-429 assertion.
      RATE_LIMIT_INTAKE_SESSION_PER_15MIN: '10000',
    },
  },
});
