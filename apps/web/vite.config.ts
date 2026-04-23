import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // libsodium-wrappers-sumo publishes a broken ESM entry that references a sibling
      // `libsodium-sumo.mjs` that is not in the package. Point Vite at the CJS build
      // explicitly; Rollup handles the CJS interop.
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
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      '/auth': 'http://localhost:4000',
      '/users': 'http://localhost:4000',
      '/groups': 'http://localhost:4000',
      '/conversations': 'http://localhost:4000',
      '/attachments': 'http://localhost:4000',
      '/socket.io': { target: 'ws://localhost:4000', ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
