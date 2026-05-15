import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useNavigate } from 'react-router-dom';
import { api, type PublicStaffCard } from '../api.js';
import { getBoot, url } from '../lib/boot.js';

/**
 * Phase 28.3 — public intake landing.
 *
 * Renders the firm-branded header (logo + name from window.__VIBE_BOOT__),
 * a responsive grid of opted-in staff cards, and the ADR-028 disclosure
 * footer. Clicking a card navigates to /intake/:staffId where the Phase
 * 28.4 form lives.
 *
 * Accessibility:
 *   - h1 page heading carries the firm name.
 *   - Each card is a real <button>, not a clickable <div>, so keyboard /
 *     screen-reader users get focus + Enter activation for free.
 *   - aria-label on the button carries the staff name + title; the
 *     visual bio is decorative (description not used by AT) — the label
 *     gives screen readers the actionable info without the 2-line bio
 *     noise.
 *   - Initials fallback uses aria-hidden so screen readers don't read
 *     "AB" before the staff name in the button label.
 */
export function Landing(): JSX.Element {
  const boot = getBoot();
  const firmName = boot.appName ?? 'Document intake';
  const navigate = useNavigate();

  const q = useQuery({
    queryKey: ['intake', 'public', 'staff'],
    queryFn: () => api.listIntakeStaff(),
  });

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-md bg-brand-600 grid place-items-center text-white font-semibold"
            aria-hidden="true"
          >
            {firmName.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">{firmName}</h1>
            <p className="text-sm text-slate-500">Send files to a member of our team.</p>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-5xl w-full px-4 py-8">
        {q.isLoading && (
          <div className="text-sm text-slate-500" role="status" aria-live="polite">
            Loading…
          </div>
        )}

        {q.isError && (
          <div
            className="rounded-md border border-rose-200 bg-rose-50 text-rose-900 text-sm p-4"
            role="alert"
          >
            We couldn&apos;t load the team list. Please refresh, or contact{' '}
            <strong>{firmName}</strong> directly.
          </div>
        )}

        {q.data && q.data.staff.length === 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 text-amber-900 text-sm p-4">
            Intake is not yet configured. Please contact <strong>{firmName}</strong> directly to
            send files.
          </div>
        )}

        {q.data && q.data.staff.length > 0 && (
          <>
            <h2 className="sr-only">Choose a team member</h2>
            <ul
              role="list"
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6"
            >
              {q.data.staff.map((s) => (
                <StaffCard key={s.id} staff={s} onSelect={() => navigate(`/intake/${s.id}`)} />
              ))}
            </ul>
          </>
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 text-xs text-slate-500 space-y-1">
          {/*
            ADR-028 user-facing disclosure. Required, verbatim — server-side
            encryption at rest is NOT end-to-end; this disclosure is the
            documented contract with walk-up visitors.
          */}
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

function StaffCard({
  staff,
  onSelect,
}: {
  staff: PublicStaffCard;
  onSelect: () => void;
}): JSX.Element {
  const labelParts = [staff.display_name];
  if (staff.title) labelParts.push(staff.title);
  const ariaLabel = `Send files to ${labelParts.join(', ')}`;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-label={ariaLabel}
        className={clsx(
          'w-full text-left rounded-lg border border-slate-200 bg-white p-5 transition',
          'hover:border-brand-500 hover:shadow-sm',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        )}
      >
        <div className="flex items-start gap-4">
          {staff.headshot_url ? (
            <img
              src={url(staff.headshot_url)}
              alt=""
              className="w-16 h-16 rounded-full object-cover border border-slate-200 flex-shrink-0"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div
              className="w-16 h-16 rounded-full bg-slate-100 border border-slate-200 grid place-items-center text-slate-500 font-medium flex-shrink-0"
              aria-hidden="true"
            >
              {initials(staff.display_name)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="font-medium text-slate-900 truncate">{staff.display_name}</div>
            {staff.title && <div className="text-sm text-slate-600 truncate">{staff.title}</div>}
            {staff.bio && (
              <p
                className="mt-2 text-sm text-slate-500"
                style={{
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 2,
                  overflow: 'hidden',
                }}
              >
                {staff.bio}
              </p>
            )}
          </div>
        </div>
        <div className="mt-4 text-sm font-medium text-brand-700">Select →</div>
      </button>
    </li>
  );
}
