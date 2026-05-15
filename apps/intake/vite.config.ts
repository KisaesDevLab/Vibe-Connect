import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Distribution mode: relative asset paths so a single build runs under
// single-app ('/') and multi-app ('/connect/') prefixes without rebuild.
// nginx's sub_filter substitutes the runtime __BASE_HREF__ placeholder in
// index.html at request time; the SPA bundle reads BASE_PATH back from
// window.__VIBE_BOOT__ via src/lib/boot.ts. See apps/web/vite.config.ts
// for the full rationale.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5175,
    proxy: {
      // The intake SPA only talks to public endpoints, but in dev we still
      // proxy /attachments so the headshot images load against the same
      // origin (no CORS dance in development).
      '/api/public/intake': 'http://localhost:4000',
      '/attachments': 'http://localhost:4000',
      '/__vibe-boot.js': 'http://localhost:4000',
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
