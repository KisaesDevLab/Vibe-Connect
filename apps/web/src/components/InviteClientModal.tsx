// Staff-side "Invite a client" modal — POSTs the new external identity, then
// immediately creates the encrypted conversation and navigates to it.
//
// Spec: vibe-connect-spec-invite-client.md. Mockup:
// vibe-connect-invite-client-mockup.html. Keep field order + section labels
// aligned with both — cosmetic drift here is confusing for staff who flip
// between design review and production.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InviteClientRequest } from '@vibe-connect/shared-types';
import { api } from '../api.js';
import { useAuth } from '../state/auth.js';
import { useCrypto } from '../state/crypto.js';
import { startExternalConversation } from '../lib/startExternalConversation.js';

type VerificationType = 'ssn' | 'ein' | 'none';
type ReverifyOption = 4 | 8 | 24 | 168 | null; // null = never

const REVERIFY_CHOICES: { value: ReverifyOption; label: string }[] = [
  { value: 4, label: '4 hours' },
  { value: 8, label: '8 hours' },
  { value: 24, label: '24 hours' },
  { value: 168, label: '7 days' },
  { value: null, label: 'Never' },
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Normalize flexible user input into E.164. Accepts `(573) 756-8961`,
// `5737568961`, `+1 573 756 8961`, etc. Returns null if we can't coerce.
// This is best-effort for common North-American formats; anything starting
// with `+` is assumed already-E.164 and only stripped of separators.
function normalizeE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return null;
    return `+${digits}`;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  return null;
}

function formatUsPhoneDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 11);
  // Strip leading country code for the display variant to match the mockup.
  const local = digits.startsWith('1') && digits.length > 10 ? digits.slice(1) : digits;
  if (local.length === 0) return '';
  if (local.length <= 3) return `(${local}`;
  if (local.length <= 6) return `(${local.slice(0, 3)}) ${local.slice(3)}`;
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6, 10)}`;
}

export interface InviteCreatedResult {
  externalIdentityId: string;
  /** Null when autoStartConversation=false (admin flow creates identity only). */
  conversationId: string | null;
  displayName: string;
  invitePublicKey: string;
  deliveryStatus: { email: 'sent' | 'failed' | null; sms: 'sent' | 'failed' | null };
  /** Provider error string surfaced when deliveryStatus.* === 'failed'. The
   *  invite toast renders this so SMTP / API failures don't hide behind a
   *  generic "email failed". */
  deliveryErrors?: { email?: string; sms?: string };
  /** True when the modal ran in resend mode and re-dispatched an invite. */
  resent?: boolean;
}

/**
 * Used by the sidebar's "click pending client → resend invite" flow. When set,
 * the modal switches to resend mode: fields are pre-filled, submit calls the
 * resend API (rotates invite_public_key + re-dispatches), and no conversation
 * is wrapped.
 */
export interface InviteResendTarget {
  clientId: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  firmClientRef: string | null;
  invitedVia: 'email' | 'sms' | null;
  verificationType: 'ssn' | 'ein' | 'none';
  reverifyEveryHours: 4 | 8 | 24 | 168 | null | undefined;
  emailNotifications: boolean | undefined;
  smsNotifications: boolean | undefined;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called once the invite (and, if enabled, the conversation) lands. */
  onCreated: (result: InviteCreatedResult) => void;
  /**
   * Called when the staff user confirms they want to open the existing
   * conversation surfaced by a duplicate 409 response. The parent is
   * responsible for resolving the identity → conversation and navigating.
   */
  onOpenExistingClient: (clientId: string, displayName: string) => void;
  /** Firm name + default reverify window, threaded in so the preview pane reads naturally. */
  firmName: string;
  defaultReverifyHours: 4 | 8 | 24 | 168;
  /** True when the firm has a non-mock SMS provider configured (dev-only envs still allow mock). */
  smsAvailable: boolean;
  /**
   * When true (default), the modal also wraps a fresh conversation key and
   * creates an external conversation so the staff user can start messaging
   * immediately. Admin-originated invites set this false — the admin is
   * creating a client on behalf of other staff and shouldn't be pinned as
   * the conversation lead.
   */
  autoStartConversation?: boolean;
  /**
   * Surface the optional "firm client ref" field under Client details.
   * Admin Clients tab passes true so back-office staff can link the Connect
   * identity to a record in the firm's accounting system; the sidebar
   * hides the field to keep the staff-facing surface minimal.
   */
  showFirmClientRef?: boolean;
  /**
   * When set, the modal runs in resend mode: pre-fills from the supplied
   * client row and rotates the invite on submit. Null/undefined → fresh
   * invite flow (default).
   */
  resendTarget?: InviteResendTarget | null;
}

export function InviteClientModal({
  open,
  onClose,
  onCreated,
  onOpenExistingClient,
  firmName,
  defaultReverifyHours,
  smsAvailable,
  autoStartConversation = true,
  showFirmClientRef = false,
  resendTarget = null,
}: Props): JSX.Element | null {
  const isResend = resendTarget !== null;
  const { user: me } = useAuth();
  const { buildConversationKey } = useCrypto();

  // All form state resets whenever the modal is (re)opened. This matches the
  // spec's "Cancel preserves no state" acceptance criterion.
  const [displayName, setDisplayName] = useState('');
  const [firmClientRef, setFirmClientRef] = useState('');
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [emailValue, setEmailValue] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [smsEnabled, setSmsEnabled] = useState(false); // flipped on in effect below if available
  const [smsDisplay, setSmsDisplay] = useState('');
  const [smsNormalized, setSmsNormalized] = useState<string | null>(null);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [verificationType, setVerificationType] = useState<VerificationType>('ssn');
  const [last4, setLast4] = useState<string[]>(['', '', '', '']);
  const [reverifyHours, setReverifyHours] = useState<ReverifyOption>(defaultReverifyHours);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{
    id: string;
    displayName: string;
    field: 'email' | 'phone';
  } | null>(null);

  const pinRefs = useRef<Array<HTMLInputElement | null>>([]);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    if (resendTarget) {
      // Pre-fill from the pending client row. Fields that the sidebar doesn't
      // carry (last4 cannot be displayed — only the hash exists) are left blank;
      // the server treats a blank last4 + unchanged verificationType as "keep
      // existing" and otherwise demands a new last4.
      setDisplayName(resendTarget.displayName);
      setFirmClientRef(resendTarget.firmClientRef ?? '');
      // Channel pre-fill. Prefer the stored preference flag if present so a
      // client invited via both channels comes back with both toggled on; fall
      // back to "whatever has a value" for legacy rows that never saved the flag.
      const emailInitiallyEnabled = resendTarget.emailNotifications ?? Boolean(resendTarget.email);
      setEmailEnabled(emailInitiallyEnabled);
      setEmailValue(resendTarget.email ?? '');
      setEmailError(null);
      const smsInitiallyEnabled =
        smsAvailable && (resendTarget.smsNotifications ?? Boolean(resendTarget.phone));
      setSmsEnabled(smsInitiallyEnabled);
      const phoneDisplay = resendTarget.phone ? formatUsPhoneDisplay(resendTarget.phone) : '';
      setSmsDisplay(phoneDisplay);
      setSmsNormalized(resendTarget.phone ?? null);
      setSmsError(null);
      setVerificationType(resendTarget.verificationType);
      setLast4(['', '', '', '']);
      setReverifyHours(
        resendTarget.reverifyEveryHours === undefined
          ? defaultReverifyHours
          : resendTarget.reverifyEveryHours,
      );
    } else {
      setDisplayName('');
      setFirmClientRef('');
      setEmailEnabled(true);
      setEmailValue('');
      setEmailError(null);
      setSmsEnabled(smsAvailable);
      setSmsDisplay('');
      setSmsNormalized(null);
      setSmsError(null);
      setVerificationType('ssn');
      setLast4(['', '', '', '']);
      setReverifyHours(defaultReverifyHours);
    }
    setServerError(null);
    setDuplicate(null);
    setSubmitting(false);
    // Focus display name on next paint. The modal is portaled at the end of the
    // DOM so the ref is guaranteed mounted by the time this fires.
    requestAnimationFrame(() => firstFieldRef.current?.focus());
  }, [open, smsAvailable, defaultReverifyHours, resendTarget]);

  // Escape-to-close, consistent with the groups modal. No confirm-on-edit yet —
  // keep the surface minimal; users can always re-open and re-type.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const emailValid = !emailEnabled || EMAIL_REGEX.test(emailValue.trim());
  const smsValid = !smsEnabled || smsNormalized !== null;
  const anyChannel = (emailEnabled && emailValid && emailValue.trim()) || (smsEnabled && smsValid);
  // In resend mode the last4 hash on the server is preserved when:
  //   - verification type didn't change AND
  //   - the 4 digit fields are left blank.
  // So "complete" is satisfied either by 4 digits typed, or — for resend — by
  // the type being unchanged and all cells blank.
  const last4AllBlank = last4.every((d) => d === '');
  const last4AllDigits = last4.every((d) => /^\d$/.test(d));
  const resendKeepsVerification = Boolean(
    isResend && resendTarget && verificationType === resendTarget.verificationType && last4AllBlank,
  );
  const last4Complete = verificationType === 'none' || last4AllDigits || resendKeepsVerification;
  const canSubmit = Boolean(
    displayName.trim().length > 0 &&
    displayName.trim().length <= 80 &&
    anyChannel &&
    last4Complete &&
    !submitting,
  );

  const previewFirstName = useMemo(() => {
    const trimmed = displayName.trim();
    return trimmed.split(/[\s—-]+/)[0] || 'your client';
  }, [displayName]);

  const verificationLabel =
    verificationType === 'ssn' ? 'SSN' : verificationType === 'ein' ? 'EIN' : null;
  const reverifyLabel =
    REVERIFY_CHOICES.find((c) => c.value === reverifyHours)?.label.toLowerCase() ?? '24 hours';

  const previewBody = useMemo(() => {
    const channelText =
      emailEnabled && smsEnabled
        ? 'An email **and** text message'
        : emailEnabled
          ? 'An email'
          : 'A text message';
    const channelSignIn =
      emailEnabled && smsEnabled
        ? 'with a code sent to either one'
        : emailEnabled
          ? 'with a code sent to the email'
          : 'with a code sent to the phone number';
    const verifyClause = verificationLabel
      ? `, verifies the last 4 of their ${verificationLabel} once per ${reverifyLabel},`
      : '';
    return `${channelText} will arrive with a link to the ${firmName} portal. ${previewFirstName} signs in ${channelSignIn}${verifyClause} and can then read and reply securely.`;
  }, [emailEnabled, smsEnabled, firmName, previewFirstName, verificationLabel, reverifyLabel]);

  function setPinCell(idx: number, raw: string): void {
    if (!/^\d?$/.test(raw)) return;
    setLast4((prev) => {
      const next = [...prev];
      next[idx] = raw;
      return next;
    });
    if (raw && idx < 3) {
      // Auto-advance. Schedule after state flush so focus lands on a mounted ref.
      requestAnimationFrame(() => pinRefs.current[idx + 1]?.focus());
    }
  }

  function onPinKeyDown(idx: number, e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Backspace' && !last4[idx] && idx > 0) {
      pinRefs.current[idx - 1]?.focus();
    }
  }

  function onEmailBlur(): void {
    const v = emailValue.trim();
    if (!emailEnabled || !v) {
      setEmailError(null);
      return;
    }
    setEmailError(EMAIL_REGEX.test(v) ? null : 'Please enter a valid email address.');
  }

  function onPhoneChange(raw: string): void {
    setSmsDisplay(formatUsPhoneDisplay(raw));
    const norm = normalizeE164(raw);
    setSmsNormalized(norm);
    if (smsError) setSmsError(null);
  }

  function onPhoneBlur(): void {
    if (!smsEnabled || !smsDisplay.trim()) {
      setSmsError(null);
      return;
    }
    if (!smsNormalized) setSmsError('Please enter a valid phone number.');
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit || !me) return;
    setSubmitting(true);
    setServerError(null);
    setDuplicate(null);

    const trimmedFirmRef = firmClientRef.trim();
    // Only send last4 when the user actually typed all 4 digits. In resend
    // mode, blank cells with unchanged verificationType are treated server-side
    // as "keep the existing hash".
    const includeLast4 = verificationType !== 'none' && last4AllDigits;
    const body: InviteClientRequest = {
      displayName: displayName.trim(),
      channels: {
        email: {
          enabled: emailEnabled,
          value: emailEnabled ? emailValue.trim() : null,
        },
        sms: {
          enabled: smsEnabled,
          value: smsEnabled ? smsNormalized : null,
        },
      },
      verification: {
        type: verificationType,
        ...(includeLast4 ? { last4: last4.join('') } : {}),
        ...(verificationType !== 'none' ? { reverifyEveryHours: reverifyHours } : {}),
      },
      ...(showFirmClientRef && trimmedFirmRef ? { firmClientRef: trimmedFirmRef } : {}),
    };

    try {
      if (isResend && resendTarget) {
        const resent = await api.resendClientInvite(resendTarget.clientId, body);
        onCreated({
          externalIdentityId: resent.externalIdentityId,
          conversationId: null,
          displayName: displayName.trim(),
          invitePublicKey: resent.invitePublicKey,
          deliveryStatus: resent.deliveryStatus,
          deliveryErrors: resent.deliveryErrors,
          resent: true,
        });
        return;
      }
      const invite = await api.inviteClient(body);

      // Admin-originated invites stop here — they create the identity for
      // other staff to pick up, and shouldn't auto-pin the admin as a
      // conversation member. Staff-originated invites continue into the
      // conversation wrap so the modal closes directly onto a messageable
      // thread (the "appears within 1 second of Send click" criterion).
      let conversationId: string | null = null;
      if (autoStartConversation) {
        conversationId = await startExternalConversation(
          me,
          {
            id: invite.externalIdentityId,
            displayName: displayName.trim(),
            invitePublicKey: invite.invitePublicKey,
          },
          buildConversationKey,
        );
      }
      onCreated({
        externalIdentityId: invite.externalIdentityId,
        conversationId,
        displayName: displayName.trim(),
        invitePublicKey: invite.invitePublicKey,
        deliveryStatus: invite.deliveryStatus,
        deliveryErrors: invite.deliveryErrors,
      });
    } catch (err) {
      // `json()` in api.ts throws Error with { status, body } attached. Pull the
      // server's structured error code when present.
      type ServerErrorBody = {
        error?: string;
        existingId?: string;
        existingDisplayName?: string;
      };
      const status = (err as { status?: number }).status;
      const rawBody = (err as { body?: string }).body;
      let parsed: ServerErrorBody | null = null;
      if (rawBody) {
        try {
          parsed = JSON.parse(rawBody) as ServerErrorBody;
        } catch {
          /* non-JSON body — fall through to generic message */
        }
      }
      if (status === 409 && parsed?.existingId) {
        const field: 'email' | 'phone' = parsed.error === 'phone_taken' ? 'phone' : 'email';
        setDuplicate({
          id: parsed.existingId,
          displayName: parsed.existingDisplayName ?? 'existing client',
          field,
        });
      } else if (status === 403 && parsed?.error === 'client_messaging_disabled') {
        setServerError(
          'Client messaging is disabled for this firm. An admin can re-enable it in Admin → Settings.',
        );
      } else {
        setServerError(
          err instanceof Error ? err.message : "We couldn't reach the server. Please try again.",
        );
      }
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4 bg-slate-900/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-client-title"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
        className="w-full max-w-[560px] bg-white rounded-xl shadow-popover overflow-hidden border border-slate-200"
      >
        <header className="flex items-start justify-between px-[18px] py-[14px] border-b border-slate-200">
          <div>
            <h2 id="invite-client-title" className="text-sm font-medium text-slate-900">
              {isResend ? 'Resend invite' : 'Invite a client'}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {isResend
                ? 'Correct any details and send a fresh invite link.'
                : 'Start a new secure conversation'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-700 p-1"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div className="px-[18px] py-4 space-y-4">
          {serverError && (
            <div className="text-xs rounded-md border border-rose-200 bg-rose-50 text-rose-800 px-3 py-2">
              {serverError}
            </div>
          )}
          {duplicate && (
            <div className="text-xs rounded-md border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 space-y-2">
              <div>
                A client with this {duplicate.field} already exists:{' '}
                <strong>{duplicate.displayName}</strong>. Open their conversation or adjust and
                re-send.
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    onOpenExistingClient(duplicate.id, duplicate.displayName);
                  }}
                  className="text-[11px] font-medium rounded-md bg-amber-700 text-white px-2.5 py-1 hover:bg-amber-800"
                >
                  Open conversation
                </button>
                <button
                  type="button"
                  onClick={() => setDuplicate(null)}
                  className="text-[11px] font-medium text-amber-900 hover:underline"
                >
                  Back to invite
                </button>
              </div>
            </div>
          )}

          <section>
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400 mb-2">
              Client details
            </div>
            <label className="block">
              <span className="text-[11px] text-slate-600">
                Display name <span className="text-rose-700">*</span>
              </span>
              <input
                ref={firstFieldRef}
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={80}
                placeholder="Rob Mathes — Crouch Farley LLC"
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm focus:border-brand-500 focus:outline-none"
                autoComplete="off"
              />
            </label>
            {showFirmClientRef && (
              <label className="block mt-2.5">
                <span className="text-[11px] text-slate-600">
                  Firm client ref <span className="text-slate-400">(optional)</span>
                </span>
                <input
                  type="text"
                  value={firmClientRef}
                  onChange={(e) => setFirmClientRef(e.target.value)}
                  maxLength={128}
                  placeholder="e.g. accounting system ID or engagement #"
                  className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm focus:border-brand-500 focus:outline-none"
                  autoComplete="off"
                />
              </label>
            )}
          </section>

          <section>
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400 mb-2">
              How to reach them
            </div>
            <p className="text-[11px] text-slate-500 mb-2.5">
              Pick one or both. The client can use either to log in to their portal.
            </p>

            <ChannelRow
              label="Email"
              icon={<EmailIcon />}
              checked={emailEnabled}
              onToggle={() => setEmailEnabled((v) => !v)}
              disabled={false}
              input={
                <input
                  type="email"
                  value={emailValue}
                  onChange={(e) => {
                    setEmailValue(e.target.value);
                    if (emailError) setEmailError(null);
                  }}
                  onBlur={onEmailBlur}
                  disabled={!emailEnabled}
                  placeholder="rob@cfhcpa.com"
                  className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm disabled:bg-slate-50 disabled:text-slate-400 focus:border-brand-500 focus:outline-none"
                  autoComplete="off"
                />
              }
              error={emailError}
            />

            <ChannelRow
              label="Mobile phone (text message)"
              icon={<PhoneIcon />}
              checked={smsEnabled}
              onToggle={() => smsAvailable && setSmsEnabled((v) => !v)}
              disabled={!smsAvailable}
              disabledTooltip={
                smsAvailable
                  ? undefined
                  : 'Set up text messages in Admin → Text messages to enable this'
              }
              pill={smsEnabled ? 'TCPA consent on first reply' : null}
              input={
                <input
                  type="tel"
                  value={smsDisplay}
                  onChange={(e) => onPhoneChange(e.target.value)}
                  onBlur={onPhoneBlur}
                  disabled={!smsEnabled}
                  placeholder="(555) 123-4567"
                  className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm disabled:bg-slate-50 disabled:text-slate-400 focus:border-brand-500 focus:outline-none"
                  autoComplete="off"
                />
              }
              error={smsError}
            />
          </section>

          <section>
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400 mb-2">
              Identity verification
            </div>
            <div
              role="tablist"
              aria-label="Identity verification type"
              className="grid grid-cols-3 gap-1 bg-slate-100 rounded-md p-1"
            >
              {(['ssn', 'ein', 'none'] as const).map((opt) => {
                const active = verificationType === opt;
                const label = opt === 'ssn' ? 'SSN' : opt === 'ein' ? 'EIN' : 'Disabled';
                return (
                  <button
                    key={opt}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setVerificationType(opt)}
                    className={
                      active
                        ? 'bg-white text-slate-900 font-medium text-xs rounded border border-slate-200 py-1.5 shadow-sm'
                        : 'text-xs text-slate-600 hover:text-slate-900 py-1.5'
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {verificationType === 'none' ? (
              <p className="mt-3 text-[11px] text-slate-600 bg-slate-50 rounded-md px-3 py-2 border border-slate-200">
                This client won&apos;t be asked to verify an SSN or EIN when they sign in. Use this
                for foreign clients or low-sensitivity relationships.
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-slate-600 block mb-1">
                    Last 4 digits of {verificationLabel}{' '}
                    {!resendKeepsVerification && <span className="text-rose-700">*</span>}
                  </label>
                  <div className="flex gap-1.5" role="group" aria-label="Last 4 digits">
                    {last4.map((v, i) => (
                      <input
                        key={i}
                        ref={(el) => {
                          pinRefs.current[i] = el;
                        }}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]"
                        maxLength={1}
                        value={v}
                        onChange={(e) => setPinCell(i, e.target.value)}
                        onKeyDown={(e) => onPinKeyDown(i, e)}
                        aria-label={`Digit ${i + 1}`}
                        className="w-9 h-10 text-center text-sm font-medium rounded-md border border-slate-300 focus:border-brand-500 focus:outline-none"
                      />
                    ))}
                  </div>
                  {isResend &&
                    resendTarget &&
                    verificationType === resendTarget.verificationType && (
                      <p className="mt-1.5 text-[10px] text-slate-500">
                        Leave blank to keep the existing digits.
                      </p>
                    )}
                </div>
                <div>
                  <label className="text-[11px] text-slate-600 block mb-1">Re-verify every</label>
                  <select
                    value={reverifyHours === null ? 'null' : String(reverifyHours)}
                    onChange={(e) =>
                      setReverifyHours(
                        e.target.value === 'null'
                          ? null
                          : (Number(e.target.value) as Exclude<ReverifyOption, null>),
                      )
                    }
                    className="w-full rounded-md border border-slate-300 px-2 py-2 text-sm bg-white focus:border-brand-500 focus:outline-none"
                  >
                    {REVERIFY_CHOICES.map((c) => (
                      <option key={c.label} value={c.value === null ? 'null' : String(c.value)}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </section>

          <section
            aria-live="polite"
            className="rounded-md bg-slate-50 border border-slate-200 px-3 py-2.5"
          >
            <div className="text-[11px] font-medium text-slate-700 mb-1">
              What {previewFirstName} will see
            </div>
            <p
              className="text-[11px] leading-relaxed text-slate-600"
              dangerouslySetInnerHTML={{ __html: renderPreview(previewBody) }}
            />
          </section>
        </div>

        <footer className="flex items-center justify-between px-[18px] py-3 border-t border-slate-200 bg-slate-50/50">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <LockIcon />
            End-to-end encrypted
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-300 text-slate-700 text-xs font-medium px-3.5 py-1.5 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-md bg-brand-600 text-white text-xs font-medium px-4 py-1.5 hover:bg-brand-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              {submitting ? 'Sending…' : isResend ? 'Resend invite' : 'Send invite'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

// --- supporting components / icons -----------------------------------------

function ChannelRow({
  label,
  icon,
  checked,
  onToggle,
  disabled,
  disabledTooltip,
  pill,
  input,
  error,
}: {
  label: string;
  icon: React.ReactNode;
  checked: boolean;
  onToggle: () => void;
  disabled: boolean;
  disabledTooltip?: string;
  pill?: string | null;
  input: React.ReactNode;
  error?: string | null;
}): JSX.Element {
  return (
    <div
      className={
        'rounded-md border border-slate-200 px-3 py-2.5 mb-2 bg-white ' +
        (disabled ? 'opacity-60' : '')
      }
      title={disabled ? disabledTooltip : undefined}
    >
      <div className="flex items-center gap-2.5 mb-2">
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          role="checkbox"
          aria-checked={checked}
          aria-label={label}
          className={
            'w-4 h-4 rounded grid place-items-center flex-shrink-0 ' +
            (checked
              ? 'bg-brand-600 border border-brand-600'
              : 'bg-white border border-slate-400') +
            (disabled ? ' cursor-not-allowed' : ' cursor-pointer')
          }
        >
          {checked && (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="3"
              strokeLinecap="round"
              aria-hidden
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="text-slate-500">{icon}</span>
          <span className="text-sm font-medium text-slate-800 truncate">{label}</span>
        </div>
        {pill && (
          <span className="text-[10px] font-medium text-emerald-900 bg-emerald-100 px-2 py-0.5 rounded-md whitespace-nowrap">
            {pill}
          </span>
        )}
      </div>
      {input}
      {error && <div className="text-[11px] text-rose-700 mt-1">{error}</div>}
    </div>
  );
}

function EmailIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <polyline points="3 7 12 13 21 7" />
    </svg>
  );
}

function PhoneIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <line x1="12" y1="18" x2="12" y2="18" />
    </svg>
  );
}

function LockIcon(): JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

// Render **bold** emphasis in the preview text without pulling in a markdown
// library — the preview copy is a closed set of phrases and the only active
// markup is **both**, driven by the channel checkbox state.
function renderPreview(text: string): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escape(text).replace(
    /\*\*(.+?)\*\*/g,
    '<strong class="font-medium text-slate-800">$1</strong>',
  );
}
