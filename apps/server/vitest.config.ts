import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    globals: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true }, // DB state is shared — avoid parallel chaos
    },
    env: {
      NODE_ENV: 'test',
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test',
      SESSION_SECRET: process.env.SESSION_SECRET ?? 'ci-session-secret-not-real',
      RATE_LIMIT_LOGIN_PER_MIN: '10000',
      RATE_LIMIT_GLOBAL_PER_MIN: '100000',
      RATE_LIMIT_PORTAL_CODE_PER_10MIN: '10000',
    },
  },
});
