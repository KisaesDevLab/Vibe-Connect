// Thin wrapper around the Tauri 2.x IPC surface. The onboarding HTML is
// served from Tauri's bundled-asset origin, so `window.__TAURI__` is always
// present at runtime in the actual desktop. We still guard it for two reasons:
//
//   1. Vite dev mode (`yarn dev` from apps/desktop) serves the page over a
//      regular HTTP server with no Tauri runtime — the same code should
//      function for visual iteration without a webview.
//   2. The `getAppVersion` and `setApplianceUrl` IPC calls fail safely when
//      __TAURI__ is missing so a developer running the page via vite dev
//      sees the form, not a blank screen with a runtime error.
//
// Keeping this in its own module lets us mock it in tests trivially.

export interface TauriBridge {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

interface TauriRuntime {
  core?: {
    invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  };
  // Tauri 1.x compatibility shim — not used in 2.x but kept to avoid breaking
  // downstream code if it lands.
  invoke?<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    __TAURI__?: TauriRuntime;
    __TAURI_INTERNALS__?: { invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
  }
}

export function tauriBridge(): TauriBridge | null {
  if (typeof window === 'undefined') return null;
  // Tauri 2.x exposes invoke at window.__TAURI__.core.invoke or
  // window.__TAURI_INTERNALS__.invoke depending on whether withGlobalTauri
  // is set. Try both — preferring the internal namespace because that's
  // what Tauri 2.x stable ships by default.
  const internals = window.__TAURI_INTERNALS__?.invoke;
  if (internals) {
    return { invoke: <T>(cmd: string, args?: Record<string, unknown>) => internals(cmd, args) as Promise<T> };
  }
  const coreInvoke = window.__TAURI__?.core?.invoke ?? window.__TAURI__?.invoke;
  if (coreInvoke) {
    return { invoke: <T>(cmd: string, args?: Record<string, unknown>) => coreInvoke(cmd, args) as Promise<T> };
  }
  return null;
}

export function isInsideTauri(): boolean {
  return tauriBridge() !== null;
}

/**
 * Persist the chosen appliance URL via the Rust IPC command. The command
 * stamps the value into tauri-plugin-store and returns the same URL on
 * success so the caller can confirm the round-trip without re-reading.
 */
export async function setApplianceUrl(url: string): Promise<string> {
  const bridge = tauriBridge();
  if (!bridge) {
    // Dev fallback: persist to localStorage so a vite-dev session is
    // self-coherent. Production never hits this branch because the bundle
    // only runs inside Tauri.
    window.localStorage.setItem('__vibe_appliance_url__', url);
    return url;
  }
  return await bridge.invoke<string>('set_appliance_url', { url });
}

/**
 * Read the current stored appliance URL, if any. Returns null when no URL
 * has been saved yet. The shell uses this to decide whether to load the
 * onboarding page or navigate straight to the appliance.
 */
export async function getApplianceUrl(): Promise<string | null> {
  const bridge = tauriBridge();
  if (!bridge) {
    const v = window.localStorage.getItem('__vibe_appliance_url__');
    return v && v.length > 0 ? v : null;
  }
  return await bridge.invoke<string | null>('get_appliance_url');
}

/**
 * Tell the Rust shell to navigate the main webview to the stored appliance
 * URL. Called from the onboarding "Continue" handler after a successful
 * probe + save. The Rust side also calls this on startup when a URL is
 * already stored — this command is a no-op if there's nothing to navigate to.
 */
export async function navigateToAppliance(): Promise<void> {
  const bridge = tauriBridge();
  if (!bridge) {
    // In dev mode, just announce what would happen.
    console.info('[onboarding] would navigate to appliance (dev mode no-op)');
    return;
  }
  await bridge.invoke<void>('navigate_to_appliance');
}

/**
 * Read the desktop shell's build version, surfaced in the footer so an
 * operator helping a customer can see at a glance which version is running.
 */
export async function getDesktopVersion(): Promise<string> {
  const bridge = tauriBridge();
  if (!bridge) return 'dev';
  try {
    return await bridge.invoke<string>('get_desktop_version');
  } catch {
    return 'unknown';
  }
}
