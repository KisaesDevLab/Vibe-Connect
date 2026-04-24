# Vibe Connect — Feature Spec: Invite a Client

*Scope: the modal and backend endpoint that lets a staff member invite an external client into a new encrypted conversation. Covers UI, validation, API contract, data model interactions, edge cases, and acceptance criteria. Written for Claude Code consumption during Phase 18 (Magic-link client guest access) of the main build plan.*

*Companion spec — read these too if touching this area:*
- *Phase 17 (Cryptography foundation) — conversation key generation and wrapping*
- *Phase 18 (Magic-link client guest access) — token generation, consent, session model*
- *Phase 19 (Client portal + access code login) — what happens after the invite lands*
- *Phase 20 (SSN/EIN step-up verification) — the verification-type field and last-4 storage*
- *Phase 25 (SMS bridge) — provider abstraction, TextLink vs. Twilio paths*
- *Addendum § Client directory visibility model — assigned lead, restricted flag*
- *Addendum § Text messages configuration — TCPA consent, opt-in flow*

---

## User story

Kurt is a staff member at a CPA firm. He's on the phone with Rob Mathes, a new client from Crouch Farley & Heuring who needs to send over some tax documents. Kurt wants to invite Rob into a secure Vibe Connect conversation so Rob can upload the documents and they can continue communicating without using email for sensitive data.

Kurt clicks "Invite a client" in the Vibe Connect sidebar. A modal opens. Kurt fills in Rob's details, confirms how to reach him (email, SMS, or both), records the last 4 of Rob's SSN for identity verification, reviews the preview of what Rob will receive, and clicks "Send invite." The modal closes. A new conversation appears in Kurt's sidebar under the "Clients" group. The invite has been sent.

Rob receives an email (and/or text message) with a link to the firm's portal. He follows the standard portal login flow (access code → SSN step-up) and lands in the conversation with Kurt.

---

## Entry points

The Invite a client modal can be opened from three places:

1. **Sidebar "Invite a client" button** at the top of the Clients group in the staff sidebar
2. **Keyboard shortcut** — `Ctrl+Shift+I` / `Cmd+Shift+I` (global when staff app is focused)
3. **Admin UI → Clients tab → "Invite new client" button**

All three entry points open the same modal component with the same state model.

---

## Layout & fields

Single modal, max-width 560px, centered, with backdrop dim at 38% opacity. Not full-screen, not multi-step. Body content is three sections plus a preview pane.

### Header

- Title: "Invite a client"
- Subtitle: "Start a new secure conversation"
- Close button (X icon) top-right

### Section 1 — Client details

Single field:

| Field | Required | Notes |
|---|---|---|
| Display name | Yes | The name staff and the client will see in the UI. Free text, 1–80 chars, trim whitespace. For a business client, use the format most useful to the firm — typically the primary contact's name, optionally followed by the business ("Rob Mathes — Crouch Farley LLC"). |

### Section 2 — How to reach them

Short instruction text: "Pick one or both. The client can use either to log in to their portal."

Two channel rows, each with identical structure:

**Email channel row:**
- Checkbox (default: checked)
- Email icon
- Label: "Email"
- Input field below: email address, validated with basic RFC 5322 regex
- If checkbox unchecked: input becomes disabled, grayed out, label text grayed

**Mobile phone channel row:**
- Checkbox (default: checked if the firm has an SMS provider configured and active, otherwise unchecked and the row is disabled with tooltip "Set up text messages in Admin → Text messages to enable this")
- Mobile phone icon
- Label: "Mobile phone (text message)"
- Inline pill next to label: "TCPA consent requested on first reply" (explains that the client's first reply containing Y / YES confirms TCPA opt-in, per § Text messages configuration)
- Input field below: E.164 phone number (auto-format as user types, accept flexible input like `(573) 756-8961` or `5737568961` or `+1 573 756 8961` and normalize)

**Validation:** At least one channel must be checked AND have a valid corresponding value. If zero channels are checked, the Send button is disabled. If a channel is checked but its field is empty or invalid, the Send button is disabled and the invalid field is flagged on blur.

### Section 3 — Identity verification

Segmented control with three mutually exclusive options:

- **SSN** (default) — prompts for 4-digit input below
- **EIN** — prompts for 4-digit input below
- **Disabled** — no input shown; displays small info box "This client won't be asked to verify an SSN or EIN when they sign in. Use this for foreign clients or low-sensitivity relationships."

When SSN or EIN is selected, two fields appear:

| Field | Required | Notes |
|---|---|---|
| Last 4 digits | Yes | 4-digit numeric input as four single-digit cells. Never displayed or logged in plaintext — bcrypt-hashed immediately on submit. |
| Re-verify every | No | Dropdown with options: 4h / 8h / 24h / 7d / never. Default: firm-level default from admin settings (typically 24h). |

### Preview pane

Small info box near the bottom of the modal, gray background. Updates dynamically based on the channel checkboxes:

- Both channels checked: "An email **and** text message will arrive with a link to the [Firm Name] portal. [Client first name] signs in with a code sent to either one, verifies the last 4 of their [SSN/EIN] once per [timeout], and can then read and reply securely."
- Email only: "An email will arrive with a link to the [Firm Name] portal. [Client first name] signs in with a code sent to the email, verifies the last 4 of their [SSN/EIN] once per [timeout], and can then read and reply securely."
- SMS only: "A text message will arrive with a link to the [Firm Name] portal. [Client first name] signs in with a code sent to the phone number, verifies the last 4 of their [SSN/EIN] once per [timeout], and can then read and reply securely."
- Verification disabled: substitute the verification clause with "and can then read and reply securely."

### Footer

Left side: small E2EE indicator ("End-to-end encrypted" with lock icon). Right side: Cancel button (secondary) and Send invite button (primary).

---

## Client-side behavior

- Modal is implemented as a React component using existing design tokens (no new CSS variables).
- Channel checkboxes control input disabled state AND affect validation AND affect preview pane text — use derived state, not duplicated state.
- Phone number input accepts any reasonable format and normalizes to E.164 on blur. Invalid numbers flag on blur with "Please enter a valid phone number."
- Email input validates on blur with a basic regex. Invalid flags with "Please enter a valid email address."
- SSN/EIN last-4 auto-advances between cells as digits are typed; backspace moves backward; only accepts digits 0-9.
- Send invite button is disabled until: display name is non-empty AND at least one channel is checked-and-valid AND (verification is disabled OR last-4 is 4 digits).
- On Send click: button shows spinner, modal content is disabled (not closed) until server response. On success: modal closes, a new conversation with the client appears in the sidebar, the staff member is automatically made a member and the assigned lead.
- On server error: inline error banner at the top of the modal body with specific message from the server. Modal stays open.

---

## API contract

### Endpoint

`POST /api/conversations/invite`

Authenticated: staff session required. Must be a member of at least one group (i.e. active staff member).

### Request body

```json
{
  "displayName": "Rob Mathes",
  "channels": {
    "email": {
      "enabled": true,
      "value": "rob@cfhcpa.com"
    },
    "sms": {
      "enabled": true,
      "value": "+15737568961"
    }
  },
  "verification": {
    "type": "ssn",
    "last4": "7234",
    "reverifyEveryHours": 24
  }
}
```

Notes on the shape:

- `channels` is an object (not an array) to make partial updates clear
- `verification.type` is one of `"ssn" | "ein" | "none"`
- When type is `"none"`, `last4` and `reverifyEveryHours` are omitted
- Phone is E.164 format after client-side normalization

### Server-side validation

1. `displayName` non-empty, length ≤ 80, trim whitespace
2. At least one channel enabled
3. For each enabled channel, value is non-empty and format-valid (regex for email, E.164 for phone)
4. If SMS channel enabled, firm must have an active SMS provider (status = "Active" in admin Text messages config) — otherwise reject with 400 and message "Text messages aren't set up for this firm. Enable them in Admin → Text messages, or invite by email only."
5. If `verification.type` in `["ssn", "ein"]`, `last4` must be exactly 4 digits
6. `reverifyEveryHours` must be one of `[4, 8, 24, 168, null]` (null = never)
7. Check duplicate: if an `external_identities` row already exists with the same email OR same phone, return 409 with a reference to the existing client and a suggestion to open that conversation instead

### Server-side processing

On valid request, perform the following in a single transaction:

1. Create `external_identities` row: id, display_name, email (if channel enabled), phone (if channel enabled), verification_type, verification_last4_hash (bcrypt of last4 with cost 10), verification_required (true if type is ssn/ein), assigned_lead_user_id = requesting user, preferences: `{"email_notifications": <channel email enabled>, "sms_notifications": <channel sms enabled>}`, first_invited_at = now, restricted = false
2. Create `conversations` row: type = 'external', display_name = null (uses external identity's name)
3. Create `conversation_members` rows: one for the external identity, one for the requesting staff user
4. Create linked `internal_thread` conversation: type = 'internal_thread', parent_conversation_id = the external conversation id, with the requesting staff user as the only member (other staff added as they join the parent)
5. Generate a fresh conversation key via `crypto/generateConversationKey()`; wrap to the requesting staff user's active device public keys
6. Create `conversation_keys` row with the wrapped keys
7. Generate a magic-link token via `tokens/generateAccessToken()` (32-byte random, HMAC-signed, 30-day expiry)
8. Create `magic_link_tokens` row with bcrypt hash of the token
9. For each enabled notification channel, enqueue a delivery job:
   - Email job uses the outbound email provider from firm config; template = "client_invite_email"
   - SMS job uses the outbound SMS provider (TextLink or Twilio); template = "client_invite_sms"
10. Write `audit_log` entry: action = "client_invited", actor = staff user id, target = external identity id, details = `{"channels": <enabled channels>}`
11. Return 201 with the new conversation id and external identity id so the client can navigate to the new conversation

### Response shape

Success (201):

```json
{
  "conversationId": "cnv_01HWZ...",
  "externalIdentityId": "ext_01HWZ...",
  "deliveryStatus": {
    "email": "queued",
    "sms": "queued"
  }
}
```

Error (400, 409, 500): standard error envelope with `error.code` and `error.message`.

---

## Data model touchpoints

Refer to the main plan Phase 1 schema and the addendum's Client directory visibility section for the full definitions. Tables written to by this flow:

| Table | Action |
|---|---|
| `external_identities` | INSERT (new row per client) |
| `conversations` | INSERT (2 rows: external + internal_thread) |
| `conversation_members` | INSERT (2 rows in external, 1 in internal_thread) |
| `conversation_keys` | INSERT (1 row for external conversation; internal_thread gets its own key in a separate step) |
| `magic_link_tokens` | INSERT (1 row) |
| `audit_log` | INSERT (1 row) |
| `sms_opt_ins` | NOT INSERTED HERE — opt-in is recorded on client's first reply (per Phase 25), not at invite time. The invite SMS itself carries opt-in language. |

---

## Email template

Template id: `client_invite_email`

Subject: "You have a secure message from [Firm Name]"

Body (plain text + HTML both supported):

```
Hi [Client Display Name],

[Staff Display Name] at [Firm Name] has started a secure conversation
with you. You can sign in to read and reply at:

[Portal URL]

When you sign in, we'll send a 6-digit code to this email address.
You'll also be asked to verify the last 4 digits of your [SSN|EIN]
to confirm your identity.

This link is for you only. Please do not forward it.

If you did not expect this message, you can safely ignore it.

— [Firm Name]
```

No tracking pixels, no unsubscribe link (this isn't marketing email — it's transactional communication from the firm). DKIM-signed. Reply-To header points at the inbound bridge address for that conversation (per Phase 22).

---

## SMS template

Template id: `client_invite_sms`

Body (1 segment, ≤ 160 chars including shortlink):

```
[Firm Name]: [Staff First Name] sent you a secure message.
Sign in: [shortlink]
Reply STOP to opt out.
```

Shortlink is the firm's own shortener (per Phase 25), not third-party. The STOP opt-out language is required by TCPA and carrier rules.

TCPA consent: this first SMS carries implicit opt-in language. A client's first reply of any kind (or inaction on STOP) is treated as opt-in. A reply of "STOP / UNSUBSCRIBE / CANCEL" triggers immediate opt-out per standard Phase 25 handling.

---

## Edge cases & error handling

1. **Duplicate email or phone.** Server returns 409 with the existing client's id. UI shows a modal replacing the invite modal: "A client with this email already exists: [Name]. Open their conversation?" with options "Open conversation" and "Back to invite."

2. **SMS provider unavailable.** If the admin has SMS configured but the provider (TextLink phone offline, Twilio 10DLC not approved) is currently unreachable, the SMS channel checkbox still works but shows a warning pill "Text message may be delayed" inline. The invite proceeds; the SMS job retries per the provider's retry policy. If it ultimately fails, an admin notification is raised.

3. **No SMS provider configured.** The SMS channel row is disabled with tooltip "Set up text messages in Admin → Text messages to enable this." Admin link opens in a new tab.

4. **Email provider misconfigured.** Same pattern — email row stays enabled but shows "Email notifications aren't fully set up" and the staff invitation proceeds; staff is alerted if delivery fails.

5. **Staff cancels mid-entry.** Cancel button closes the modal without saving. No prompt required unless the form has been edited — if edited, a confirmation: "Discard this invite?"

6. **Modal closed via Escape key.** Same as Cancel.

7. **Network error on Send.** Error banner "We couldn't reach the server. Please try again." with a retry button that re-submits. Idempotency: the API endpoint uses an `Idempotency-Key` header (client generates a UUID when the modal opens; same key on retry) so a double-send doesn't create two clients.

8. **Slow send (queue backed up).** If the server processes in > 3 seconds, the UI shows "Still working..." with an updated spinner. If > 15 seconds, the UI shows a banner "This is taking longer than usual. Your invite is being processed." and allows the modal to be closed — the staff member can see the new conversation appear in the sidebar when it completes.

9. **Client is already in the system but previously paused.** Duplicate detection (edge case 1) handles this; admin UI provides a "reactivate" flow that re-sends the invite using stored contact info.

10. **Firm doesn't have a configured portal URL yet.** Send button is disabled with tooltip "The client portal isn't set up yet. Ask an admin to configure it in Admin → Public internet access." Same link pattern as SMS.

---

## Acceptance criteria

This feature is not complete until all of the following are demonstrably true:

- [ ] A staff member can invite a client with email only, SMS only, or both, and the client receives exactly the enabled notifications
- [ ] Sending an invite with zero channels selected is impossible (Send button disabled, server rejects if UI is bypassed)
- [ ] An invalid email or phone is caught client-side on blur AND server-side on submit
- [ ] Duplicate email or phone presents the "open existing conversation" path instead of creating a duplicate
- [ ] The new conversation appears in the staff sidebar within 1 second of Send button click
- [ ] The internal side-thread is created automatically and contains the inviting staff member
- [ ] The SSN/EIN last-4 is bcrypt-hashed and never logged, audit-logged, or otherwise persisted in plaintext
- [ ] The audit log receives an entry for the invite with the actor, target, and enabled channels
- [ ] The email template renders correctly in Gmail, Outlook, Apple Mail, and a plain-text client
- [ ] The SMS message fits in 1 segment and contains the firm name, sender first name, shortlink, and STOP language
- [ ] Cancel preserves no state; opening the modal again starts fresh
- [ ] A staff member without SMS permissions (if role-based) cannot enable the SMS channel — UI disables the row, server rejects if bypassed
- [ ] Keyboard accessibility: Tab traversal hits every field in order; Enter submits only from the Send button; Escape cancels; all controls have ARIA labels

---

## Out of scope for this feature

- Bulk client import (separate CSV import flow — Admin UI)
- Editing an existing client (separate client record flow)
- Reactivating a paused client (separate flow)
- Inviting multiple staff to a new external conversation simultaneously (staff are added one at a time via join requests after creation)
- Scheduling an invite to be sent later
- Custom invite message text written by the staff member (template is firm-configurable by admins, not per-invite)

---

## Files to create/modify (engineering roadmap)

Client:

- `apps/web/src/features/invite/InviteClientModal.tsx` — the modal component
- `apps/web/src/features/invite/schema.ts` — zod schema for form validation matching server schema
- `apps/web/src/features/invite/ChannelRow.tsx` — reusable checkbox+field row
- `apps/web/src/features/invite/VerificationPicker.tsx` — the SSN/EIN/Disabled segmented control
- `apps/web/src/features/invite/PreviewPane.tsx` — the dynamic preview pane
- `apps/web/src/hooks/useInviteClient.ts` — TanStack Query mutation with idempotency-key generation

Server:

- `apps/server/src/routes/conversations/invite.ts` — the endpoint
- `apps/server/src/services/invite/createExternalConversation.ts` — the transactional service
- `apps/server/src/services/invite/dispatchInviteNotifications.ts` — the email/SMS dispatch logic
- `apps/server/src/templates/email/client_invite_email.{html,txt}.eta` — email template (Eta or similar)
- `apps/server/src/templates/sms/client_invite_sms.txt` — SMS template
- `packages/shared-types/invite.ts` — request/response types shared between client and server

Tests:

- Unit tests for validation schema (both sides)
- Integration test for the full endpoint including transaction rollback on failure
- Component test for the modal covering all validation states and the duplicate-client flow
- E2E test: staff creates invite → external identity and conversation rows present in DB → notification job enqueued → (in a test harness) delivered to a mock email/SMS receiver

---

## Human notes for Claude Code

- This feature touches crypto, access control, and notifications — the three most important concerns in the product. Do not skip tests; error-handling shortcuts here become CPA-compliance problems later.
- Always run validations server-side. Client-side validation is for UX only.
- The bcrypt cost for the SSN/EIN last-4 hash is deliberately only 10 (not 12 like passwords), because the input space is 10,000 values and step-up verification needs to be fast. Do not change this without understanding the tradeoff.
- The `Idempotency-Key` header handling must use a persistent store (Postgres row) with TTL, not in-memory cache — server restarts can happen between user's first click and their retry.
- Do not reuse the internal-message template code path for invite emails — the invite is a template-specific transactional email, not an E2EE message. Templates live in `templates/` on the server and render server-side.
- The internal side-thread must be created even though only one staff member is initially a member. Future staff additions propagate automatically.
- The `assigned_lead_user_id` on the new external identity row is critical for the "Request to join" flow from other staff members (see addendum § Client directory visibility). Do not leave it null.
