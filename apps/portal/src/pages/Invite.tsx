// Portal invite acceptance landing page. URL: /invite?id=<uuid>&t=<base64url 48 bytes>
//
// The invite URL carries a 48-byte token: first 16 bytes identify the invite (proved
// via bcrypt on the server), last 32 bytes seed a deterministic X25519 keypair
// (libsodium crypto_box_SEEDBYTES). The server computed the same public key at
// invite time and wrapped every sent-ahead conversation key to it. Here the
// browser reconstructs the matching private key and requests a portal session.
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { url } from '../lib/boot.js';

export function InvitePage(): JSX.Element {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [state, setState] = useState<'working' | 'error' | 'done'>('working');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = params.get('id');
    const t = params.get('t');
    if (!id || !t) {
      setError('Invite link is missing required parameters.');
      setState('error');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const crypto = await import('@vibe-connect/crypto');
        await crypto.ready();
        // base64url-decode the 48-byte token (16-byte id + 32-byte seed).
        const padded = t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4);
        const raw = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
        if (raw.byteLength !== 48) throw new Error('malformed_token');
        const tokenId = raw.subarray(0, 16);
        const seed = raw.subarray(16, 48);
        const kp = await crypto.keypairFromSeed(new Uint8Array(seed));
        // Portal conversation page reads session keys from sessionStorage by design.
        sessionStorage.setItem('sessionPublicKey', kp.publicKey);
        sessionStorage.setItem('sessionSecretKey', kp.secretKey);
        // tokenId is the first half of the token, base64-encoded (standard) — matches what
        // the server bcrypts.
        const tokenIdBase64 = btoa(String.fromCharCode(...tokenId));
        const res = await fetch(url('/portal/invite-accept'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            externalIdentityId: id,
            tokenIdBase64,
            sessionPublicKey: kp.publicKey,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `invite_accept_${res.status}`);
        }
        const body = (await res.json()) as { verificationRequired: boolean };
        if (cancelled) return;
        setState('done');
        // Tiny pause so the user sees the "success" state before redirect.
        setTimeout(() => {
          if (body.verificationRequired) nav('/stepup');
          else nav('/messages');
        }, 400);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error && err.message === 'invalid'
            ? 'This invite link is no longer valid. Ask your firm to send a new one.'
            : err instanceof Error
              ? err.message
              : 'Unable to accept the invite.',
        );
        setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, nav]);

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm bg-white shadow rounded-xl p-8 space-y-3 text-center">
        <div className="mx-auto w-12 h-12 rounded-lg bg-brand-600 text-white grid place-items-center font-bold text-xl">
          VC
        </div>
        {state === 'working' && (
          <>
            <h1 className="text-lg font-semibold">Accepting your invite…</h1>
            <p className="text-sm text-slate-500">
              One moment while we set up your secure connection.
            </p>
          </>
        )}
        {state === 'done' && (
          <>
            <h1 className="text-lg font-semibold text-emerald-700">Connected ✓</h1>
            <p className="text-sm text-slate-500">Taking you to your messages…</p>
          </>
        )}
        {state === 'error' && (
          <>
            <h1 className="text-lg font-semibold text-rose-700">Invite link isn&apos;t valid</h1>
            <p className="text-sm text-slate-600">{error}</p>
          </>
        )}
      </div>
    </div>
  );
}
