import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type ResolvedIntakeLink } from '../api.js';
import { url } from '../lib/boot.js';

/**
 * Phase 28.14 — tokenized intake landing at /intake/t/:token.
 *
 * The staff-sent link path. The recipient lands here directly from an
 * email/SMS link issued by 28.13; this bypasses the staff-card grid.
 *
 *   1. GET /api/public/intake/links/:token → staff card + optional note +
 *      prefilled contact. 404 / 410 render a terminal "link no longer
 *      valid" screen.
 *   2. Form mirrors 28.4 IntakeForm (name + email/phone), prefilled with
 *      whatever the link carried. No Turnstile — the link itself is the
 *      unforgeable handle; per-token rate limit (10/h) lives on the server.
 *   3. POST /sessions with `linkToken` (not `staffId`). On 201 stash the
 *      upload token and navigate to /intake/:staffId/upload — same flow
 *      as the public path joins.
 */
export function TokenizedIntake(): JSX.Element {
  const params = useParams<{ token: string }>();
  const token = params.token ?? '';
  const navigate = useNavigate();

  const linkQuery = useQuery<ResolvedIntakeLink, Error & { status?: number; code?: string }>({
    queryKey: ['intake', 'link', token],
    queryFn: () => api.resolveIntakeLink(token),
    retry: false,
  });

  // Form state — initialise from server prefill once the query resolves.
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!linkQuery.data) return;
    setEmail((prev) => (prev ? prev : linkQuery.data.prefillEmail ?? ''));
    setPhone((prev) => (prev ? prev : linkQuery.data.prefillPhone ?? ''));
  }, [linkQuery.data]);

  const nameOk = name.trim().length >= 1 && name.trim().length <= 120;
  const emailLooksValid = email.length === 0 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneLooksValid = phone.length === 0 || /^[\d\s+()\-.]{7,32}$/.test(phone.trim());
  const contactPresent = email.trim().length > 0 || phone.trim().length > 0;
  const canSubmit = !submitting && nameOk && emailLooksValid && phoneLooksValid && contactPresent;

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.createSession({
        linkToken: token,
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      sessionStorage.setItem(
        `vibe-intake-token:${res.sessionId}`,
        JSON.stringify({ uploadToken: res.uploadToken, expiresAt: res.expiresAt }),
      );
      // `replace: true` so the back-button doesn't land on the raw
      // `/intake/t/<token>` URL. On a shared device the token would
      // otherwise live in browser history indefinitely.
      navigate(`/intake/${linkQuery.data!.staff.id}/upload?s=${res.sessionId}`, {
        replace: true,
      });
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? 'unknown';
      setError(messageFor(code));
    } finally {
      setSubmitting(false);
    }
  }

  if (linkQuery.isLoading) {
    return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  }

  // 404 / 410 / staff_unavailable all collapse to the same terminal
  // message — the recipient should contact the firm. The distinction
  // matters for the audit row but never for the visitor.
  if (linkQuery.isError) {
    const status = linkQuery.error?.status;
    const isGone = status === 410 || status === 404;
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-md border border-rose-200 bg-rose-50 p-6">
          <h1 className="text-base font-semibold text-rose-900">
            {isGone ? 'This link is no longer valid' : 'We couldn’t load this link'}
          </h1>
          <p className="mt-2 text-sm text-rose-900">
            {isGone
              ? 'The link may have expired or been revoked. Please contact the firm directly to request a new one.'
              : 'Please try refreshing the page, or contact the firm directly.'}
          </p>
        </div>
      </div>
    );
  }

  const link = linkQuery.data!;
  const staff = link.staff;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-2xl px-4 py-6 flex items-center gap-4">
          {staff.headshot_url ? (
            <img
              src={url(staff.headshot_url)}
              alt=""
              className="w-14 h-14 rounded-full object-cover border border-slate-200"
            />
          ) : (
            <div
              className="w-14 h-14 rounded-full bg-slate-100 border border-slate-200 grid place-items-center text-slate-500 font-medium"
              aria-hidden="true"
            >
              {initials(staff.display_name)}
            </div>
          )}
          <div>
            <h1 className="text-lg font-semibold text-slate-900">
              Send files to {staff.display_name}
            </h1>
            {staff.title && <p className="text-sm text-slate-600">{staff.title}</p>}
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-2xl w-full px-4 py-6">
        {link.note && (
          <div
            className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
            role="note"
          >
            <div className="font-medium mb-1">Note from {staff.display_name}:</div>
            <div className="whitespace-pre-wrap">{link.note}</div>
          </div>
        )}

        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <p className="text-sm text-slate-600">
            We&apos;ll use this to confirm receipt — we won&apos;t email or call you for anything
            else.
          </p>

          <label className="block">
            <span className="text-sm text-slate-700">Your name</span>
            <input
              type="text"
              required
              autoComplete="name"
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input"
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-700">
              Email <span className="text-slate-400">(optional)</span>
            </span>
            <input
              type="email"
              autoComplete="email"
              maxLength={255}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              aria-invalid={email.length > 0 && !emailLooksValid}
            />
            {email.length > 0 && !emailLooksValid && (
              <div className="text-xs text-rose-600">Enter a valid email address.</div>
            )}
          </label>

          <label className="block">
            <span className="text-sm text-slate-700">
              Phone <span className="text-slate-400">(optional)</span>
            </span>
            <input
              type="tel"
              autoComplete="tel"
              maxLength={32}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="input"
              placeholder="(555) 123-4567"
              aria-invalid={phone.length > 0 && !phoneLooksValid}
            />
            {phone.length > 0 && !phoneLooksValid && (
              <div className="text-xs text-rose-600">Enter a valid phone number.</div>
            )}
          </label>

          {!contactPresent && name.length > 0 && (
            <div className="text-xs text-amber-700" role="status" aria-live="polite">
              Enter at least one — an email address or a phone number — so we can confirm receipt.
            </div>
          )}

          {error && <div className="text-sm text-rose-600">{error}</div>}

          <div className="flex items-center gap-3">
            <button type="submit" className="btn-primary" disabled={!canSubmit}>
              {submitting ? 'Submitting…' : 'Continue'}
            </button>
          </div>
        </form>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-2xl px-4 py-6 text-xs text-slate-500 space-y-1">
          <p>
            Files uploaded here are encrypted at rest. By proceeding you confirm the documents are
            yours to share. This page does not create an account.
          </p>
        </div>
      </footer>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function messageFor(code: string): string {
  switch (code) {
    case 'contact_required':
      return 'Enter at least one — an email address or a phone number.';
    case 'link_revoked':
      return 'This link has been revoked. Please contact the firm directly.';
    case 'link_expired':
      return 'This link has expired. Please contact the firm directly.';
    case 'link_not_found':
      return 'This link is not valid. Please contact the firm directly.';
    case 'link_rate_limited':
      return 'Too many submissions on this link. Please wait an hour or contact the firm directly.';
    case 'staff_unavailable':
      return 'The team member this link was for is no longer available. Please contact the firm directly.';
    case 'rate_limited':
      return 'Too many attempts. Please wait a few minutes before trying again.';
    case 'bad_request':
      return 'Please check the form fields and try again.';
    default:
      return 'Submission failed. Please try again.';
  }
}
