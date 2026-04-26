// Tests the Tauri IPC wrapper. The wrapper has two code paths:
//   - inside Tauri: __TAURI__/__TAURI_INTERNALS__ is present, IPC routes
//     to the Rust commands defined in main.rs.
//   - outside Tauri (vite dev): falls back to localStorage so visual
//     iteration works without spinning up the desktop shell.
//
// These tests pin the dev-mode fallback. The "inside Tauri" path is exercised
// via a mocked __TAURI_INTERNALS__.invoke spy so we can assert the right
// command names + arg shapes are emitted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWindow {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: {
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
}

function makeWindow(): FakeWindow {
  const store: Record<string, string> = {};
  return {
    localStorage: {
      getItem: (k) => (k in store ? store[k]! : null),
      setItem: (k, v) => {
        store[k] = v;
      },
      removeItem: (k) => {
        delete store[k];
      },
    },
  };
}

// Casting through `unknown` keeps tsc happy when we shove a stripped-down
// FakeWindow onto globalThis — the real Window type has hundreds of fields
// the tests don't care about.
function installWindow(win: FakeWindow): void {
  (globalThis as unknown as { window: FakeWindow }).window = win;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('isInsideTauri()', () => {
  it('returns false when no __TAURI__ runtime is present', async () => {
    installWindow(makeWindow());
    const { isInsideTauri } = await import('../lib/tauri.js');
    expect(isInsideTauri()).toBe(false);
  });

  it('returns true when __TAURI_INTERNALS__.invoke is present (Tauri 2.x default)', async () => {
    const win = makeWindow();
    win.__TAURI_INTERNALS__ = { invoke: () => Promise.resolve(null) };
    installWindow(win);
    const { isInsideTauri } = await import('../lib/tauri.js');
    expect(isInsideTauri()).toBe(true);
  });

  it('returns true when __TAURI__.core.invoke is present (withGlobalTauri)', async () => {
    const win = makeWindow();
    (win as unknown as { __TAURI__: unknown }).__TAURI__ = {
      core: { invoke: () => Promise.resolve(null) },
    };
    installWindow(win);
    const { isInsideTauri } = await import('../lib/tauri.js');
    expect(isInsideTauri()).toBe(true);
  });
});

describe('dev-mode fallback (no Tauri runtime)', () => {
  it('setApplianceUrl writes to localStorage and round-trips via getApplianceUrl', async () => {
    installWindow(makeWindow());
    const { setApplianceUrl, getApplianceUrl } = await import('../lib/tauri.js');
    await setApplianceUrl('https://connect.test.local');
    expect(await getApplianceUrl()).toBe('https://connect.test.local');
  });

  it('getApplianceUrl returns null when no value has been stored', async () => {
    installWindow(makeWindow());
    const { getApplianceUrl } = await import('../lib/tauri.js');
    expect(await getApplianceUrl()).toBeNull();
  });

  it('navigateToAppliance is a no-op (logs only)', async () => {
    installWindow(makeWindow());
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { navigateToAppliance } = await import('../lib/tauri.js');
    await expect(navigateToAppliance()).resolves.toBeUndefined();
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  it('getDesktopVersion returns "dev" outside Tauri', async () => {
    installWindow(makeWindow());
    const { getDesktopVersion } = await import('../lib/tauri.js');
    expect(await getDesktopVersion()).toBe('dev');
  });
});

describe('IPC routing (mocked __TAURI_INTERNALS__)', () => {
  function mountTauri(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
    const win = makeWindow();
    win.__TAURI_INTERNALS__ = { invoke };
    installWindow(win);
  }

  it('setApplianceUrl invokes set_appliance_url with { url }', async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    mountTauri((cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve('https://x.test');
    });
    const { setApplianceUrl } = await import('../lib/tauri.js');
    const out = await setApplianceUrl('https://x.test');
    expect(out).toBe('https://x.test');
    expect(calls).toEqual([{ cmd: 'set_appliance_url', args: { url: 'https://x.test' } }]);
  });

  it('getApplianceUrl invokes get_appliance_url with no args', async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    mountTauri((cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve('https://stored.test');
    });
    const { getApplianceUrl } = await import('../lib/tauri.js');
    expect(await getApplianceUrl()).toBe('https://stored.test');
    expect(calls).toEqual([{ cmd: 'get_appliance_url', args: undefined }]);
  });

  it('navigateToAppliance invokes navigate_to_appliance with no args', async () => {
    const calls: string[] = [];
    mountTauri((cmd) => {
      calls.push(cmd);
      return Promise.resolve(undefined);
    });
    const { navigateToAppliance } = await import('../lib/tauri.js');
    await navigateToAppliance();
    expect(calls).toEqual(['navigate_to_appliance']);
  });

  it('getDesktopVersion swallows IPC errors and returns "unknown"', async () => {
    mountTauri(() => Promise.reject(new Error('ipc died')));
    const { getDesktopVersion } = await import('../lib/tauri.js');
    expect(await getDesktopVersion()).toBe('unknown');
  });
});
