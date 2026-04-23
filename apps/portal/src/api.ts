async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`${res.status}`), { status: res.status, body });
  }
  return (await res.json()) as T;
}

export const portalApi = {
  identify: (identifier: string) =>
    json<{ ok: true; sent: boolean; hint?: string }>('/portal/identify', {
      method: 'POST',
      body: JSON.stringify({ identifier }),
    }),
  verify: (identifier: string, code: string, sessionPublicKey: string) =>
    json<{
      ok: true;
      sessionId: string;
      verificationRequired: boolean;
      verificationType: 'ssn' | 'ein' | 'none';
    }>('/portal/verify', {
      method: 'POST',
      body: JSON.stringify({ identifier, code, sessionPublicKey }),
    }),
  stepup: (last4: string) =>
    json<{ ok: true; verifiedUntil: string | null }>('/portal/stepup', {
      method: 'POST',
      body: JSON.stringify({ last4 }),
    }),
  me: () =>
    json<{
      session: { id: string; verifiedUntil: string | null };
      identity: {
        id: string;
        displayName: string;
        email: string;
        phone: string | null;
        verificationRequired: boolean;
        verificationType: 'ssn' | 'ein' | 'none';
        hasVerification: boolean;
      } | null;
    }>('/portal/me'),
  logout: () => json<{ ok: true }>('/portal/logout', { method: 'POST' }),
};
