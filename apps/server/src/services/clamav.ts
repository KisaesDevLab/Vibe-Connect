// Minimal ClamAV INSTREAM client. Speaks the wire protocol directly to avoid a heavy
// client dependency. Only active when CLAMD_HOST is set — falls back to "clean stub"
// otherwise so dev/CI without clamd still works.
//
// Protocol summary (clamav-daemon docs, INSTREAM command):
//   -> "zINSTREAM\0"
//   -> uint32-BE chunk length + chunk bytes (repeated)
//   -> uint32-BE 0 (end marker)
//   <- null-terminated status string like "stream: OK\0" or "stream: Win.Trojan.Fake FOUND\0"
import net from 'node:net';
import { env } from '../env.js';
import { logger } from '../logger.js';

export type ScanResult =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  | { status: 'error'; message: string };

export function clamdEnabled(): boolean {
  return Boolean(env.clamdHost);
}

export type ProbeResult =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'timeout' | 'connect_error' | 'bad_response'; message?: string };

/**
 * Send zPING\0 to clamd and expect "PONG" back. Non-fatal: callers (typically
 * the server boot path) just log the outcome. When CLAMD_HOST is unset this
 * returns `{ok:false, reason:'disabled'}` immediately without opening a socket.
 *
 * Phase 28 uses this as a one-shot startup readiness probe so an operator
 * tailing `docker logs` after a restart sees `clamav.ready` (or the failure
 * mode) without waiting for the first upload to expose the misconfiguration.
 */
export async function probeClamd(timeoutMs = 5_000): Promise<ProbeResult> {
  if (!clamdEnabled()) return { ok: false, reason: 'disabled' };
  return new Promise<ProbeResult>((resolve) => {
    const sock = net.createConnection({ host: env.clamdHost, port: env.clamdPort });
    let settled = false;
    const settle = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs);
    let resp = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      resp = Buffer.concat([resp, chunk]);
      // clamd terminates PING with a null byte (z-command framing). Settle
      // as soon as we see it rather than waiting for `end`.
      if (resp.includes(0)) {
        const line = resp.toString('utf8').replace(/\0$/, '').trim();
        if (line === 'PONG') settle({ ok: true });
        else settle({ ok: false, reason: 'bad_response', message: line });
      }
    });
    sock.on('timeout', () => settle({ ok: false, reason: 'timeout' }));
    sock.on('error', (err) => settle({ ok: false, reason: 'connect_error', message: err.message }));
    sock.on('connect', () => {
      sock.write('zPING\0');
    });
  });
}

export async function scanBuffer(buffer: Buffer): Promise<ScanResult> {
  if (!clamdEnabled()) return { status: 'clean' };
  return new Promise<ScanResult>((resolve) => {
    const sock = net.createConnection({ host: env.clamdHost, port: env.clamdPort });
    sock.setTimeout(30_000);

    // Single-shot guard so the `end` callback that fires after a manual
    // `destroy()` can't double-resolve. Same shape as probeClamd; without
    // it, a timeout/error path resolves and then `end` resolves again.
    // Promise semantics make the second resolve a no-op, but the
    // `destroy()` was still missing on the error path — leaked a socket
    // per failure. Adding it here.
    let settled = false;
    const settle = (r: ScanResult): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(r);
    };

    let resp = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      resp = Buffer.concat([resp, chunk]);
    });
    sock.on('timeout', () => settle({ status: 'error', message: 'clamd_timeout' }));
    sock.on('error', (err) => settle({ status: 'error', message: err.message }));
    sock.on('end', () => {
      const line = resp.toString('utf8').replace(/\0$/, '').trim();
      // clamd returns e.g. "stream: OK" or "stream: Eicar-Test-Signature FOUND"
      if (/\bOK$/.test(line)) {
        settle({ status: 'clean' });
        return;
      }
      const m = /:\s*(.+)\s+FOUND$/.exec(line);
      if (m) {
        settle({ status: 'infected', signature: m[1]! });
        return;
      }
      // Everything else — explicit ERROR strings, empty responses, or
      // unrecognised formats — collapses to `error` with the raw line for
      // the caller to log. Fail-closed: callers (upload routes) translate
      // `error` into a 503 so bytes never ship without a verdict.
      settle({ status: 'error', message: line });
    });

    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      // Send in 64 KiB chunks.
      const CHUNK = 65_536;
      for (let off = 0; off < buffer.length; off += CHUNK) {
        const slice = buffer.subarray(off, Math.min(off + CHUNK, buffer.length));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(slice.length, 0);
        sock.write(len);
        sock.write(slice);
      }
      // End marker.
      const end = Buffer.alloc(4);
      end.writeUInt32BE(0, 0);
      sock.write(end);
    });
  }).then((result) => {
    if (result.status === 'error') logger.warn('clamav.scan_error', { message: result.message });
    return result;
  });
}
