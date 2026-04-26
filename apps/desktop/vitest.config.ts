// Vitest config for the desktop onboarding bundle. We point the include
// glob at the __tests__ directory so the build output (dist/) and Vite
// shell never get scanned.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['onboarding/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
