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

export async function scanBuffer(buffer: Buffer): Promise<ScanResult> {
  if (!clamdEnabled()) return { status: 'clean' };
  return new Promise<ScanResult>((resolve) => {
    const sock = net.createConnection({ host: env.clamdHost, port: env.clamdPort });
    sock.setTimeout(30_000);

    let resp = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      resp = Buffer.concat([resp, chunk]);
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolve({ status: 'error', message: 'clamd_timeout' });
    });
    sock.on('error', (err) => {
      resolve({ status: 'error', message: err.message });
    });
    sock.on('end', () => {
      const line = resp.toString('utf8').replace(/\0$/, '').trim();
      // clamd returns e.g. "stream: OK" or "stream: Eicar-Test-Signature FOUND"
      if (/\bOK$/.test(line)) {
        resolve({ status: 'clean' });
        return;
      }
      const m = /:\s*(.+)\s+FOUND$/.exec(line);
      if (m) {
        resolve({ status: 'infected', signature: m[1]! });
        return;
      }
      // Everything else — explicit ERROR strings, empty responses, or
      // unrecognised formats — collapses to `error` with the raw line for
      // the caller to log. Fail-closed: callers (upload routes) translate
      // `error` into a 503 so bytes never ship without a verdict.
      resolve({ status: 'error', message: line });
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
