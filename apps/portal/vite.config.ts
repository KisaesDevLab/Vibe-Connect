import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Distribution mode: relative asset paths so a single build runs under both
  // single-app ('/') and multi-app ('/connect/') prefixes without rebuild.
  // See apps/web/vite.config.ts for the full rationale.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'libsodium-wrappers-sumo': path.resolve(
        __dirname,
        '../../node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js',
      ),
    },
  },
  optimizeDeps: {
    exclude: ['libsodium-wrappers-sumo'],
  },
  server: {
    port: 5174,
    proxy: {
      '/portal': 'http://localhost:4000',
      '/conversations': 'http://localhost:4000',
      '/attachments': 'http://localhost:4000',
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
