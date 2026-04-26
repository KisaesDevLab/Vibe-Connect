import { describe, expect, it } from 'vitest';
import {
  describeNormalizeError,
  describeProbeError,
  normalizeApplianceUrl,
  validateBootScript,
} from '../lib/url.js';

describe('normalizeApplianceUrl', () => {
  it('rejects empty / whitespace strings', () => {
    expect(normalizeApplianceUrl('')).toMatchObject({ ok: false, error: 'empty' });
    expect(normalizeApplianceUrl('   ')).toMatchObject({ ok: false, error: 'empty' });
  });

  it('defaults bare hostnames to https://', () => {
    const r = normalizeApplianceUrl('connect.smithcpa.com');
    expect(r).toMatchObject({ ok: true, url: 'https://connect.smithcpa.com', scheme: 'https' });
  });

  it('preserves an explicit https:// scheme', () => {
    const r = normalizeApplianceUrl('https://connect.smithcpa.com');
    expect(r).toMatchObject({ ok: true, url: 'https://connect.smithcpa.com' });
  });

  it('preserves a non-default port', () => {
    const r = normalizeApplianceUrl('https://connect.smithcpa.com:8443');
    expect(r).toMatchObject({ ok: true, url: 'https://connect.smithcpa.com:8443' });
  });

  it('strips a trailing slash so concatenation is unambiguous', () => {
    const r = normalizeApplianceUrl('https://connect.smithcpa.com/');
    expect(r).toMatchObject({ ok: true, url: 'https://connect.smithcpa.com' });
  });

  it('refuses http:// in production mode', () => {
    const r = normalizeApplianceUrl('http://connect.smithcpa.com');
    expect(r).toMatchObject({ ok: false, error: 'http_in_production' });
  });

  it('allows http:// when allowHttp:true (developer override)', () => {
    const r = normalizeApplianceUrl('http://localhost:4000', { allowHttp: true });
    expect(r).toMatchObject({ ok: true, url: 'http://localhost:4000', scheme: 'http' });
  });

  it('rejects schemes other than http/https', () => {
    expect(normalizeApplianceUrl('ftp://example.com')).toMatchObject({
      ok: false,
      error: 'unsupported_scheme',
      detail: 'ftp',
    });
    expect(normalizeApplianceUrl('file:///etc/passwd')).toMatchObject({
      ok: false,
      error: 'unsupported_scheme',
    });
    expect(normalizeApplianceUrl('javascript:alert(1)')).toMatchObject({
      ok: false,
      error: 'unsupported_scheme',
    });
  });

  it('preserves a sub-path for multi-app appliances', () => {
    // BASE_PATH=/connect deployments live at https://shared/connect/.
    // The user enters that URL verbatim; we keep the path so the probe
    // fetches /connect/__vibe-boot.js (not /__vibe-boot.js, which would 404).
    expect(normalizeApplianceUrl('https://shared.host/connect')).toMatchObject({
      ok: true,
      url: 'https://shared.host/connect',
    });
    expect(normalizeApplianceUrl('https://shared.host/connect/')).toMatchObject({
      ok: true,
      url: 'https://shared.host/connect',
    });
    expect(normalizeApplianceUrl('https://shared.host/connect//')).toMatchObject({
      ok: true,
      url: 'https://shared.host/connect',
    });
  });

  it('preserves a multi-segment sub-path verbatim', () => {
    expect(normalizeApplianceUrl('https://host/team/connect')).toMatchObject({
      ok: true,
      url: 'https://host/team/connect',
    });
  });

  it('rejects query strings + fragments', () => {
    expect(normalizeApplianceUrl('https://connect.smithcpa.com?foo=bar')).toMatchObject({
      ok: false,
      error: 'has_query',
    });
    expect(normalizeApplianceUrl('https://connect.smithcpa.com#main')).toMatchObject({
      ok: false,
      error: 'has_fragment',
    });
  });

  it('rejects malformed URLs', () => {
    // bare scheme is not a valid URL
    expect(normalizeApplianceUrl('https://')).toMatchObject({ ok: false });
    // a literal IPv6 without brackets
    expect(normalizeApplianceUrl('https://::1')).toMatchObject({ ok: false });
  });

  it('preserves an IPv4 literal hostname', () => {
    const r = normalizeApplianceUrl('https://10.0.0.5:4000');
    expect(r).toMatchObject({ ok: true, url: 'https://10.0.0.5:4000' });
  });

  it('keeps the bracketed IPv6 literal verbatim', () => {
    const r = normalizeApplianceUrl('https://[::1]:4000');
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.url).toMatch(/\[?::1\]?:4000$/);
  });
});

describe('validateBootScript', () => {
  const goodPayload = JSON.stringify({
    basePath: '',
    siteUrl: 'https://connect.smithcpa.com',
    portalUrl: 'https://connect.smithcpa.com/portal',
    tlsMode: 'internal',
    appName: 'Smith CPA',
    buildVersion: 'v1.2.3',
  });

  it('parses a happy-path bootstrap script', () => {
    const body = `window.__VIBE_BOOT__ = ${goodPayload};\n`;
    const r = validateBootScript(body);
    expect(r).toMatchObject({
      ok: true,
      basePath: '',
      tlsMode: 'internal',
      appName: 'Smith CPA',
      buildVersion: 'v1.2.3',
    });
  });

  it('parses multi-app mode (basePath = /connect)', () => {
    const payload = JSON.stringify({
      basePath: '/connect',
      siteUrl: '',
      portalUrl: '',
      tlsMode: 'external',
      appName: null,
      buildVersion: 'dev',
    });
    const body = `window.__VIBE_BOOT__ = ${payload};\n`;
    const r = validateBootScript(body);
    expect(r).toMatchObject({
      ok: true,
      basePath: '/connect',
      tlsMode: 'external',
      appName: null,
    });
  });

  it('flags non-vibe responses (HTML 200, 404 page, etc.)', () => {
    expect(validateBootScript('<!doctype html><html>...</html>')).toMatchObject({
      ok: false,
      error: 'not_a_vibe_server',
    });
    expect(validateBootScript('Cannot GET /__vibe-boot.js')).toMatchObject({
      ok: false,
      error: 'not_a_vibe_server',
    });
  });

  it('flags malformed bootstrap (assignment but no JSON)', () => {
    expect(validateBootScript('window.__VIBE_BOOT__ = "oops";\n')).toMatchObject({
      ok: false,
      error: 'invalid_json',
    });
    expect(validateBootScript('window.__VIBE_BOOT__ = ;\n')).toMatchObject({
      ok: false,
      error: 'invalid_json',
    });
  });

  it('flags JSON missing required fields', () => {
    const body = `window.__VIBE_BOOT__ = ${JSON.stringify({ basePath: '/' })};\n`;
    expect(validateBootScript(body)).toMatchObject({ ok: false, error: 'wrong_shape' });
  });

  it('flags JSON with the wrong tlsMode value', () => {
    const payload = JSON.stringify({ basePath: '', tlsMode: 'whatever', buildVersion: 'x' });
    const body = `window.__VIBE_BOOT__ = ${payload};\n`;
    expect(validateBootScript(body)).toMatchObject({ ok: false, error: 'wrong_shape' });
  });

  it('tolerates pretty-printed JSON spanning multiple lines', () => {
    const body = `window.__VIBE_BOOT__ = {\n  "basePath": "",\n  "tlsMode": "internal",\n  "buildVersion": "v1"\n};\n`;
    expect(validateBootScript(body)).toMatchObject({ ok: true });
  });
});

describe('describeNormalizeError + describeProbeError', () => {
  it('returns a non-empty user-facing string for every NormalizeError', () => {
    const errs: Array<Parameters<typeof describeNormalizeError>[0]> = [
      'empty',
      'malformed',
      'no_hostname',
      'http_in_production',
      'unsupported_scheme',
      'has_query',
      'has_fragment',
    ];
    for (const e of errs) {
      const msg = describeNormalizeError(e, 'foo');
      expect(msg).toBeTruthy();
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('returns a non-empty user-facing string for every ProbeError', () => {
    const errs: Array<Parameters<typeof describeProbeError>[0]> = [
      'not_a_vibe_server',
      'invalid_json',
      'wrong_shape',
    ];
    for (const e of errs) {
      const msg = describeProbeError(e);
      expect(msg).toBeTruthy();
      expect(msg.length).toBeGreaterThan(0);
    }
  });
});
