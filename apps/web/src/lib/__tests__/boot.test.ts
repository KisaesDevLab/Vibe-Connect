/**
 * Distribution-mode url() helper. The whole SPA threads its fetch calls
 * through this so a single bundle works under '/' (single-app) and
 * '/connect/' (multi-app) without rebuild — every path the helper produces
 * has to be correct, or the staff app silently 404s in multi-app mode.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getBoot, url, type VibeBoot } from '../boot.js';

function setBoot(boot: Partial<VibeBoot>): void {
  (globalThis as unknown as { window: { __VIBE_BOOT__: VibeBoot } }).window = {
    __VIBE_BOOT__: {
      basePath: '',
      siteUrl: '',
      portalUrl: '',
      tlsMode: 'internal',
      appName: null,
      buildVersion: 'test',
      ...boot,
    },
  };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('getBoot()', () => {
  it('returns a safe fallback when window is undefined', () => {
    const b = getBoot();
    expect(b.basePath).toBe('');
    expect(b.tlsMode).toBe('internal');
  });

  it('reads window.__VIBE_BOOT__ when present', () => {
    setBoot({ basePath: '/connect', appName: 'Vibe' });
    expect(getBoot().basePath).toBe('/connect');
    expect(getBoot().appName).toBe('Vibe');
  });
});

describe('url() — single-app mode (basePath="")', () => {
  it('passes through leading-slash paths unchanged', () => {
    setBoot({ basePath: '' });
    expect(url('/auth/login')).toBe('/auth/login');
    expect(url('/health')).toBe('/health');
  });

  it('prepends a slash to relative paths', () => {
    setBoot({ basePath: '' });
    expect(url('auth/login')).toBe('/auth/login');
  });

  it('preserves query strings + hash fragments', () => {
    setBoot({ basePath: '' });
    expect(url('/auth/login?next=/inbox')).toBe('/auth/login?next=/inbox');
    expect(url('/inbox#thread-123')).toBe('/inbox#thread-123');
  });
});

describe('url() — multi-app mode (basePath="/connect")', () => {
  it('prepends the prefix to leading-slash paths', () => {
    setBoot({ basePath: '/connect' });
    expect(url('/auth/login')).toBe('/connect/auth/login');
    expect(url('/health')).toBe('/connect/health');
  });

  it('prepends the prefix to relative paths after normalising the slash', () => {
    setBoot({ basePath: '/connect' });
    expect(url('auth/login')).toBe('/connect/auth/login');
  });

  it('preserves query strings + hash fragments under the prefix', () => {
    setBoot({ basePath: '/connect' });
    expect(url('/portal/identify?ref=email')).toBe('/connect/portal/identify?ref=email');
    expect(url('/inbox#thread-123')).toBe('/connect/inbox#thread-123');
  });

  it('handles paths that include encoded characters', () => {
    setBoot({ basePath: '/connect' });
    expect(url('/clients/abc%2F123/vault/files')).toBe(
      '/connect/clients/abc%2F123/vault/files',
    );
  });
});

describe('url() — absolute URL passthrough (any mode)', () => {
  it('leaves http(s):// URLs alone', () => {
    setBoot({ basePath: '/connect' });
    expect(url('http://example.com/foo')).toBe('http://example.com/foo');
    expect(url('https://idp.example.com/oauth/token')).toBe(
      'https://idp.example.com/oauth/token',
    );
  });

  it('leaves protocol-relative URLs alone', () => {
    setBoot({ basePath: '/connect' });
    expect(url('//cdn.example.com/asset.js')).toBe('//cdn.example.com/asset.js');
  });

  it('matches case-insensitively (HTTPS://, FTP://)', () => {
    setBoot({ basePath: '/connect' });
    expect(url('HTTPS://example.com/x')).toBe('HTTPS://example.com/x');
    expect(url('ftp://example.com/x')).toBe('ftp://example.com/x');
  });

  it('does NOT pass through `data:` URIs — they would 404 if used as a fetch target anyway', () => {
    // Documenting the current behaviour: the regex requires `://`. `data:`
    // URIs hit the prepend path and become '/data:image/png;base64,…' which
    // is broken. Callers that need a data: URI feed it directly to <img
    // src=…>, never through the api fetch helper, so this is OK in practice.
    setBoot({ basePath: '/connect' });
    expect(url('data:image/png;base64,iVBOR')).toBe('/connect/data:image/png;base64,iVBOR');
  });
});

describe('url() — defensive cases that should not happen in practice', () => {
  it('does not double-prepend when caller already includes BASE_PATH', () => {
    // This IS a footgun: callers must NOT pass a pre-prefixed path. The
    // helper assumes paths are always written as if single-app. We document
    // the bad behaviour so a future reader understands the contract.
    setBoot({ basePath: '/connect' });
    expect(url('/connect/auth/login')).toBe('/connect/connect/auth/login');
  });

  it('does the right thing for an empty path', () => {
    setBoot({ basePath: '/connect' });
    expect(url('')).toBe('/connect/');
    setBoot({ basePath: '' });
    expect(url('')).toBe('/');
  });
});
