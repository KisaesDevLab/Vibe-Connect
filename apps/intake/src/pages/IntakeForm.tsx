import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type PublicStaffCard } from '../api.js';
import { getBoot, url } from '../lib/boot.js';

/**
 * Phase 28.4 — anonymous intake form at /intake/:staffId.
 *
 * Walk-up flow:
 *   1. Render selected-staff header (re-fetches the public /staff listing
 *      and picks the row by id — no new endpoint needed).
 *   2. Collect name + email and/or phone with live + server-side validation.
 *   3. Lazy-load Cloudflare Turnstile when boot.turnstileSiteKey is set.
 *   4. POST /api/public/intake/sessions. On 201, stash the upload token in
 *      sessionStorage and navigate to /intake/:staffId/upload (Phase 28.5
 *      surface — for now a placeholder route in App.tsx).
 *
 * sessionStorage (not localStorage) so the token is gone when the tab
 * closes — matches the 4h server-side TTL conceptually and avoids
 * leaving a token sitting in another browser context.
 */
export function IntakeForm(): JSX.Element {
  const boot = getBoot();
  const params = useParams<{ staffId: string }>();
  const staffId = params.staffId ?? '';
  const navigate = useNavigate();

  const staffQuery = useQuery({
    queryKey: ['intake', 'public', 'staff'],
    queryFn: () => api.listIntakeStaff(),
  });

  const staff = useMemo<PublicStaffCard | null>(() => {
    return staffQuery.data?.staff.find((s) => s.id === staffId) ?? null;
  }, [staffQuery.data, staffId]);

  // v0.4.37: persist form fields per staffId so a user who clicks
  // Continue, then taps the browser Back button, lands back here with
  // their inputs still filled in. User report: "when i clicked back
  // the inputs were gone and i had to start over." sessionStorage
  // (not localStorage) so a closed tab clears it; keyed per staffId so
  // switching to a different team member doesn't carry data over.
  // turnstileToken is intentionally NOT persisted — Cloudflare tokens
  // are single-use server-side, so a stale persisted token would just
  // fail the next submit. The widget re-renders on rehydrate and the
  // user solves a fresh challenge.
  const FORM_STORAGE_KEY = `vibe-intake-form:${staffId}`;
  type PersistedForm = { name: string; email: string; phone: string; message: string };
  function readPersisted(): PersistedForm | null {
    try {
      const raw = sessionStorage.getItem(FORM_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<PersistedForm>;
      // Defensive: ignore anything that doesn't structurally match —
      // a future schema change shouldn't silently inject the wrong
      // type into useState.
      return {
        name: typeof parsed.name === 'string' ? parsed.name : '',
        email: typeof parsed.email === 'string' ? parsed.email : '',
        phone: typeof parsed.phone === 'string' ? parsed.phone : '',
        message: typeof parsed.message === 'string' ? parsed.message : '',
      };
    } catch {
      return null;
    }
  }
  const initial = readPersisted();
  // Form state. Initialized lazily from sessionStorage so an in-progress
  // form survives a back-navigation from the upload page.
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [message, setMessage] = useState(initial?.message ?? '');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Persist on every change. JSON.stringify of four short strings is
  // sub-ms; debouncing would add complexity without a measurable win.
  useEffect(() => {
    try {
      sessionStorage.setItem(FORM_STORAGE_KEY, JSON.stringify({ name, email, phone, message }));
    } catch {
      // sessionStorage quota or private-mode block — fall through;
      // the in-memory state still drives the UI, we just lose the
      // back-button persistence.
    }
  }, [FORM_STORAGE_KEY, name, email, phone, message]);

  // Inline-validation flags. Email/phone are RFC-5322 / E.164-ish — server
  // is the authoritative validator; this is just so the Submit button
  // disables when obviously wrong.
  const nameOk = name.trim().length >= 1 && name.trim().length <= 120;
  const emailLooksValid = email.length === 0 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneLooksValid = phone.length === 0 || /^[\d\s+()\-.]{7,32}$/.test(phone.trim());
  const contactPresent = email.trim().length > 0 || phone.trim().length > 0;
  // Server caps at 2000 chars; we mirror the limit here so the user gets
  // immediate feedback instead of a round-trip 400.
  const MESSAGE_MAX = 2000;
  const messageOk = message.length <= MESSAGE_MAX;
  const turnstileRequired = Boolean(boot.turnstileSiteKey);
  const turnstileOk = !turnstileRequired || Boolean(turnstileToken);
  const canSubmit =
    !submitting &&
    nameOk &&
    emailLooksValid &&
    phoneLooksValid &&
    contactPresent &&
    messageOk &&
    turnstileOk;

  useTurnstileWidget({
    siteKey: boot.turnstileSiteKey,
    onToken: setTurnstileToken,
    onReset: () => setTurnstileToken(null),
  });

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.createSession({
        staffId,
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        message: message.trim() || undefined,
        turnstileToken: turnstileToken ?? undefined,
      });
      // Stash the token in sessionStorage keyed by sessionId so the upload
      // page (28.5) can pick it up. Both fields go in one record so a
      // future "switch which session is active" doesn't have to read two
      // separate keys.
      sessionStorage.setItem(
        `vibe-intake-token:${res.sessionId}`,
        JSON.stringify({ uploadToken: res.uploadToken, expiresAt: res.expiresAt }),
      );
      // v0.4.38: do NOT clear FORM_STORAGE_KEY here. v0.4.37 cleared
      // it on submit success, which broke the back-button case the
      // fix was trying to solve — the user navigates to /upload,
      // hits Back, the form remounts, readPersisted() returns null
      // (because we just cleared), and the form is empty. The whole
      // point of the persistence is to survive back-navigation.
      //
      // Trade-off accepted: a same-tab return visit to /intake/:staffId
      // after a successful submit will pre-fill with the prior contact
      // info. That's fine — same browser, same person, almost certainly
      // re-submitting on the same intake. They can edit fields freely.
      // The data clears on tab close (sessionStorage scope).
      navigate(`/intake/${staffId}/upload?s=${res.sessionId}`);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? 'unknown';
      setError(messageFor(code));
      // Turnstile tokens are single-use on the server side; force a fresh
      // challenge on next attempt so the user can retry without a full
      // page reload.
      if (turnstileRequired) setTurnstileToken(null);
      window.turnstile?.reset?.();
    } finally {
      setSubmitting(false);
    }
  }

  if (staffQuery.isLoading) {
    return <div className="p-4 text-sm text-slate-500">Loading…</div>;
  }
  if (staffQuery.isError || !staff) {
    return (
      <div className="p-6 max-w-lg mx-auto">
        <div className="rounded-md border border-rose-200 bg-rose-50 text-rose-900 text-sm p-4">
          We couldn&apos;t find that team member. They may no longer be available for intake.
          <div className="mt-3">
            <button type="button" className="btn-secondary" onClick={() => navigate('/intake')}>
              Back to the team list
            </button>
          </div>
        </div>
      </div>
    );
  }

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

          {!contactPresent && (name.length > 0 || email.length > 0 || phone.length > 0) && (
            <div className="text-xs text-amber-700" role="status" aria-live="polite">
              Enter at least one — an email address or a phone number — so we can confirm receipt.
            </div>
          )}

          <label className="block">
            <span className="text-sm text-slate-700">
              Message <span className="text-slate-400">(optional)</span>
            </span>
            <textarea
              rows={4}
              maxLength={MESSAGE_MAX}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="input"
              placeholder="Anything we should know about these files?"
              aria-describedby="message-help"
            />
            <div
              id="message-help"
              className="text-xs text-slate-500 flex items-center justify-between mt-1"
            >
              <span>Shown to staff with your files.</span>
              <span aria-live="polite">
                {message.length}/{MESSAGE_MAX}
              </span>
            </div>
          </label>

          {/*
            Turnstile widget mount-point. The lazy-loader hook above injects
            the iframe-bearing widget here when boot.turnstileSiteKey is set;
            otherwise the div stays empty and the form posts without a token.
          */}
          {boot.turnstileSiteKey && (
            <div className="my-2">
              <div className="cf-turnstile" data-sitekey={boot.turnstileSiteKey} />
            </div>
          )}

          {error && <div className="text-sm text-rose-600">{error}</div>}

          <div className="flex items-center gap-3">
            <button type="submit" className="btn-primary" disabled={!canSubmit}>
              {submitting ? 'Submitting…' : 'Continue'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => navigate('/intake')}
              disabled={submitting}
            >
              Back
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

/**
 * Lazy-load Cloudflare's Turnstile script, render the widget into any
 * `.cf-turnstile` div on the page, and forward the issued token to the
 * form. We do NOT bundle the Turnstile JS — it's loaded directly from
 * Cloudflare, which is the documented vendor path. CSP `script-src 'self'`
 * would block this; the nginx CSP for the intake bundle SHOULD allow
 * https://challenges.cloudflare.com if Turnstile is enabled. (Deferred
 * to Phase 28.17 polish — TURNSTILE_SITE_KEY unset means no widget loads,
 * which is the default for the appliance.)
 */
function useTurnstileWidget({
  siteKey,
  onToken,
  onReset: _onReset,
}: {
  siteKey: string | null;
  onToken: (token: string) => void;
  onReset: () => void;
}): void {
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!siteKey) return;
    // If the script is already on the page (HMR / back-nav), skip the
    // injection and let the existing `turnstile` global re-bind to the
    // new widget mount-point.
    if (!document.getElementById('cf-turnstile-script')) {
      const s = document.createElement('script');
      s.id = 'cf-turnstile-script';
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    }
    // Cloudflare's auto-render finds .cf-turnstile divs and binds a
    // global callback we wire into via window-level config. Setting it
    // here (per-mount) keeps it scoped to the latest form instance.
    window.__vibeTurnstileCallback = (token: string) => {
      onTokenRef.current(token);
    };
    // The widget's data-callback attribute is the documented way to
    // receive the token — we use the function name configured above.
    // To keep the JSX clean we patch the attribute after mount.
    const t = setTimeout(() => {
      const el = document.querySelector('.cf-turnstile');
      if (el && !el.hasAttribute('data-callback')) {
        el.setAttribute('data-callback', '__vibeTurnstileCallback');
      }
    }, 50);
    return () => {
      clearTimeout(t);
    };
  }, [siteKey]);
}

function messageFor(code: string): string {
  switch (code) {
    case 'contact_required':
      return 'Enter at least one — an email address or a phone number.';
    case 'unknown_staff':
      return 'That team member is no longer available for intake.';
    case 'turnstile_failed':
      return 'The challenge didn’t verify. Please try again.';
    case 'rate_limited':
      return 'Too many attempts. Please wait a few minutes before trying again.';
    case 'bad_request':
      return 'Please check the form fields and try again.';
    default:
      return 'Submission failed. Please try again.';
  }
}

// Cloudflare Turnstile sets `window.turnstile` once loaded; the widget
// callback we register is read from the global symbol set on window above.
declare global {
  interface Window {
    turnstile?: { reset?: () => void };
    __vibeTurnstileCallback?: (token: string) => void;
  }
}
