// Vite config for the Tauri shell's onboarding bundle.
//
// The bundle is a single HTML page (apps/desktop/onboarding/index.html) plus
// inline TS modules that the user sees on first run, before they've told the
// shell which Vibe Connect appliance to point at. Once the URL is committed
// the Rust shell navigates the webview straight to the appliance — this
// bundle is never loaded again until the user picks "Change server…".
//
// `root` is the onboarding directory so index.html is the entry. Output goes
// to apps/desktop/dist; tauri.conf.json's `frontendDist` matches.
//
// `base: './'` keeps every emitted asset path relative so the bundle works
// when Tauri serves it from `tauri://localhost/` (Linux/macOS) or
// `https://tauri.localhost/` (Windows). An absolute base would 404 the moment
// Tauri's internal scheme didn't match what Vite assumed.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(__dirname, 'onboarding'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5180,
    strictPort: true,
  },
});
