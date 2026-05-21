// Thin fetch wrappers for the Phase 28 public intake endpoints. Same
// `url()`-prepending shape as apps/web and apps/portal so a single bundle
// works in both single-app and multi-app modes. `credentials: 'omit'` —
// no session cookie should ever ride along on an anonymous flow; this
// is enforced by the server's public router too, but defence-in-depth.
import { url } from './lib/boot.js';

export interface PublicStaffCard {
  id: string;
  display_name: string;
  title: string | null;
  bio: string | null;
  headshot_url: string | null;
  order: number | null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(url(path), { credentials: 'omit' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`${res.status}: ${body}`), { status: res.status, body });
  }
  return (await res.json()) as T;
}

/**
 * Body the SPA posts to /api/public/intake/sessions. The server's zod
 * schema (routes/intakePublic.ts) is the authoritative type — keep these
 * in sync. Exactly one of `staffId` (28.4 public path) or `linkToken`
 * (28.14 tokenized path) is required; the server enforces this via an
 * xor-refine and returns 400 with error:'route_required' on mismatch.
 * Email + phone are both optional but at least one must be present
 * after the server resolves the link's prefill — 400 'contact_required'
 * otherwise.
 */
export interface CreateSessionBody {
  staffId?: string;
  linkToken?: string;
  name: string;
  email?: string;
  phone?: string;
  /** Optional free-text note. Server caps at 2000 chars, trims, and
   *  encrypts at rest under the firm's intake key. Rendered on the PDF
   *  cover page and in the staff detail view. */
  message?: string;
  turnstileToken?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  uploadToken: string;
  expiresAt: string;
}

/**
 * Shape returned by GET /api/public/intake/links/:token. 404 → unknown
 * token (or shape doesn't match the 22-char base64url pattern); 410 →
 * the link existed but is now gone (revoked / expired / staff deactivated).
 * The SPA surfaces both 410 paths the same way — recipient is told the
 * link is no longer valid and pointed at the firm's contact path.
 */
export interface ResolvedIntakeLink {
  linkId: string;
  staff: PublicStaffCard;
  note: string | null;
  prefillEmail: string | null;
  prefillPhone: string | null;
  expiresAt: string;
}

export const api = {
  listIntakeStaff: () => getJson<{ staff: PublicStaffCard[] }>('/api/public/intake/staff'),

  /**
   * Resolve a tokenized intake link. Throws an Error with `.status` and
   * `.code` set on a 404/410 so the calling page can render the right
   * terminal-state message.
   */
  resolveIntakeLink: async (token: string): Promise<ResolvedIntakeLink> => {
    const res = await fetch(url(`/api/public/intake/links/${encodeURIComponent(token)}`), {
      credentials: 'omit',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: { error?: string } | null = null;
      try {
        parsed = JSON.parse(text) as { error?: string };
      } catch {
        parsed = null;
      }
      throw Object.assign(new Error(`resolve_link_${res.status}`), {
        status: res.status,
        code: parsed?.error ?? 'unknown',
      });
    }
    return (await res.json()) as ResolvedIntakeLink;
  },

  /**
   * Submit the anonymous intake form. Returns the session id + a 4h-TTL
   * JWT the upload pipe (Phase 28.5) presents as a Bearer token. The
   * caller stashes the token in sessionStorage; nothing about this flow
   * involves cookies, so the token IS the auth.
   */
  createSession: async (body: CreateSessionBody): Promise<CreateSessionResponse> => {
    const res = await fetch(url('/api/public/intake/sessions'), {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: { error?: string } | null = null;
      try {
        parsed = JSON.parse(text) as { error?: string };
      } catch {
        parsed = null;
      }
      throw Object.assign(new Error(`session_create_${res.status}`), {
        status: res.status,
        code: parsed?.error ?? 'unknown',
        body: text,
      });
    }
    return (await res.json()) as CreateSessionResponse;
  },
};
