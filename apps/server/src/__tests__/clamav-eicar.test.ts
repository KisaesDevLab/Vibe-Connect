/**
 * ClamAV EICAR integration test (Phase 28.0 acceptance criterion).
 *
 * The companion `clamav.test.ts` file mocks clamd with a scripted fake server
 * so the unit suite stays hermetic; that file commandeers CLAMD_HOST /
 * CLAMD_PORT during `beforeAll`. This file is the *integration* check that
 * actually exercises the real `clamav/clamav-debian` sidecar shipped in
 * `infra/docker/docker-compose.yml`.
 *
 * It is opt-in via `CLAMAV_E2E=1` so the default `yarn test` run stays green
 * on machines without the sidecar (CI, contributors who only run unit tests).
 *
 * Why not call `services/clamav.ts:scanBuffer`? Because `env.clamdHost` is
 * frozen at module-import time by the unit fixture in `clamav.test.ts`
 * (vitest config uses `pool: 'forks', singleFork: true` — modules are shared
 * across the run). Inlining the INSTREAM wire protocol here gives us an
 * independent target host/port without disturbing the unit tests.
 *
 * Bring-up:
 *   yarn compose:up                     # starts the clamav sidecar
 *   # wait ~5 minutes on first boot for freshclam to download signatures;
 *   # `docker compose logs clamav` shows when it's ready.
 *   CLAMAV_E2E=1 yarn workspace @vibe-connect/server test clamav-eicar
 */
import net from 'node:net';
import { describe, expect, it } from 'vitest';

const ENABLED = process.env.CLAMAV_E2E === '1';
const HOST = process.env.CLAMAV_E2E_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CLAMAV_E2E_PORT ?? '3310');

// The canonical EICAR test string. Anti-virus engines that pass the EICAR
// compliance test detect this 68-byte ASCII pattern as a "virus" even
// though it's harmless. Defined here as concatenation to avoid any local
// AV on the test runner flagging the source file at rest.
const EICAR =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}' + '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Send an INSTREAM scan request directly to clamd. Returns the raw response
 * line (null-byte stripped) so the test can assert on the FOUND signature.
 */
function scanAtClamd(host: string, port: number, payload: Buffer, timeoutMs = 15_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs);
    let resp = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      resp = Buffer.concat([resp, chunk]);
    });
    sock.on('timeout', () => {
      sock.destroy();
      reject(new Error(`clamd timeout connecting to ${host}:${port}`));
    });
    sock.on('error', (err) => reject(err));
    sock.on('end', () => {
      resolve(resp.toString('utf8').replace(/\0$/, '').trim());
    });
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(payload.length, 0);
      sock.write(len);
      sock.write(payload);
      const end = Buffer.alloc(4);
      end.writeUInt32BE(0, 0);
      sock.write(end);
    });
  });
}

describe.skipIf(!ENABLED)('ClamAV sidecar — EICAR detection (integration)', () => {
  it('detects the EICAR test string and reports a FOUND signature', async () => {
    const line = await scanAtClamd(HOST, PORT, Buffer.from(EICAR, 'utf8'));
    // clamd response shape: "stream: <SignatureName> FOUND"
    expect(line).toMatch(/FOUND$/);
    // The canonical signature name from ClamAV's official database is
    // "Win.Test.EICAR_HDB-1" or close variants ("Eicar-Test-Signature"
    // historically). Accept anything matching the EICAR family.
    expect(line.toLowerCase()).toMatch(/eicar/);
  });

  it('returns OK for a plain-text non-malicious buffer', async () => {
    const line = await scanAtClamd(HOST, PORT, Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8'));
    expect(line).toMatch(/\bOK$/);
  });
});
