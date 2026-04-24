/**
 * ClamAV scan client tests. scanBuffer() drives attachment delivery: the
 * upload path treats only status === 'clean' as deliverable, so these tests
 * pin the three return shapes — clean, infected, error — and their wire
 * formats. Without clamd configured the function short-circuits to clean
 * (documented fallback for appliances deployed without the AV daemon).
 *
 * env.clamdHost is read once at module import. We set process.env BEFORE
 * the first import below so every test can reuse the same fake server on
 * the same port, and switch behaviour via the mutable `scriptedResponse`
 * reference rather than re-importing the module.
 */
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Responder = (write: (buf: Buffer | string) => void, end: () => void) => void;

let server: net.Server | null = null;
let scriptedResponse: Responder = (_write, end) => end();

beforeAll(async () => {
  // Spin up the fake clamd and capture the bound port BEFORE importing
  // clamav.ts so env.ts picks up the right CLAMD_HOST + _PORT.
  server = net.createServer((sock) => {
    sock.on('data', () => {
      // A real INSTREAM exchange sends length-prefixed chunks then a zero
      // end marker — we don't need to model that here because the client
      // buffers all bytes until the server ends the connection.
      scriptedResponse(
        (buf) => sock.write(buf),
        () => sock.end(),
      );
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address() as AddressInfo;
  process.env.CLAMD_HOST = '127.0.0.1';
  process.env.CLAMD_PORT = String(addr.port);
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

describe('scanBuffer', () => {
  it('parses "stream: OK" into clean', async () => {
    scriptedResponse = (write, end) => {
      write('stream: OK\0');
      end();
    };
    const { scanBuffer, clamdEnabled } = await import('../services/clamav.js');
    expect(clamdEnabled()).toBe(true);
    const res = await scanBuffer(Buffer.from('plain content'));
    expect(res).toEqual({ status: 'clean' });
  });

  it('parses "stream: Eicar-Test-Signature FOUND" into infected + signature', async () => {
    scriptedResponse = (write, end) => {
      write('stream: Eicar-Test-Signature FOUND\0');
      end();
    };
    const { scanBuffer } = await import('../services/clamav.js');
    const res = await scanBuffer(Buffer.from('eicar-like'));
    expect(res).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' });
  });

  it('returns error when clamd drops the connection without a verdict', async () => {
    // No-op responder — server closes immediately. Upload path treats this
    // as 503 fail-closed; a 'clean' here would silently let unscanned bytes
    // through.
    scriptedResponse = (_write, end) => end();
    const { scanBuffer } = await import('../services/clamav.js');
    const res = await scanBuffer(Buffer.from('x'));
    expect(res.status).toBe('error');
  });

  it('returns error when the response is unintelligible', async () => {
    scriptedResponse = (write, end) => {
      write('gibberish not a verdict\0');
      end();
    };
    const { scanBuffer } = await import('../services/clamav.js');
    const res = await scanBuffer(Buffer.from('x'));
    expect(res.status).toBe('error');
  });
});
