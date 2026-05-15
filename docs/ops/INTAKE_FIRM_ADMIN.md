# Vibe File Transfer (Intake) — Firm Admin Guide

> Day-to-day administration of the public intake feature inside a Vibe
> Connect firm. For appliance-level deployment + key rotation, see
> [INTAKE.md](./INTAKE.md).

The intake feature lets walk-up clients send files to a specific staff
member without an account, either by selecting a staff card from
`/intake` or by following a tokenized link sent by staff (Phase 28.13).
Every uploaded file is encrypted at rest with a firm-held libsodium
key — **not end-to-end**; see the disclosure language on `/intake` and
[ADR-028](../ADR-028-server-side-encryption-rationale.md).

---

## Staff cards

`Admin → Intake cards` lists every active staff user.

For each user:

- **Show on intake card** — boolean opt-in. Off by default; flipping
  it adds the user to the public `/intake` grid within one cache TTL
  (60 s).
- **Title** — e.g. "Payroll lead". 60-character cap.
- **Bio** — 280 chars. Plain text only; no markdown.
- **Headshot** — JPEG/PNG/WebP, square crop, ≤ 5 MB. Stored under
  `/attachments/intake-headshots/` and served publicly.
- **Order** — admin-only drag-reorder. NULL sorts last; ties broken
  by display name.

Staff can edit their own title/bio/headshot from `Account → Intake
card` (Phase 28.2). Only admins can flip another staff member's opt-in
or reorder the grid.

**Audit:** every card change writes one of `intake.card.updated`,
`intake.card.headshot_updated`, `intake.card.order_changed`.

---

## Sending a link

`Admin → Intake links` is the send-a-link generator (Phase 28.13).

1. Click **New link**.
2. Enter at least one of email or phone — the recipient receives the
   link via that channel.
3. Optionally:
   - Choose a different assigned staff (admin only; staff can only
     create links for themselves).
   - Add a 500-character note that appears above the form on the
     recipient's landing page.
   - Set an expiry: `24h`, `7d` (default), `30d`, or a custom ISO
     datetime.
4. Click **Create & send**. The send is **synchronous** — staff get
   immediate "Sent" or "Failed" feedback. Audit rows:
   `intake.link.created` then `intake.link.sent` or
   `intake.link.send_failed`.

Each link's URL is `https://<firm>.example.com/intake/t/<22-char token>`.
The recipient lands on a page showing the assigned staff card + your
note + a form prefilled with the contact info you entered. Their POST
to create the intake session is rate-limited (10 sessions / hour /
token) and skips Turnstile because the token IS the unforgeable handle.

**Revoke** a link from the table — sets `revoked_at` and turns the URL
into a 410. Audit: `intake.link.revoked`.

**Resend** uses the same template; another `intake.link.resent` audit
row fires. Resending a revoked or expired link returns an error.

---

## Received uploads

`Admin → Intake` is the staff-facing list.

- Each row shows received-at, staff, status, file count, size, an
  **Expires** column (Phase 28.15 — see [Retention](#retention)).
- **Notification failed** chip means the email/SMS receipt couldn't be
  delivered (3 attempts exhausted). Investigate via Admin → Intake
  audit filter on `intake.client_notification.failed`.
- **Linked** chip means the session has been associated with a client
  in the directory.
- **Archived** removes the session from the default list (per-user
  state; admins archive for themselves).

Clicking a row opens the detail panel with:

- **Client** info (name, email, phone) — **decrypted on view**, which
  writes `intake.session.decrypted_on_view` to the audit log.
- **Linked Connect client** — link to an existing directory client so
  the intake session shows up on that client's history.
- **Files** — each downloadable; `intake.file.downloaded` per click.
- **Assembled PDF** — Phase 28.9 cover sheet + scanned-image PDF, when
  conversion completes. `intake.pdf.downloaded` per click.
- **Retention** — manage the session's auto-delete schedule
  ([Retention](#retention)).

RBAC: staff only see sessions assigned to themselves. Admins see all
sessions and can filter by `?staffId=<uuid>`.

---

## Retention

`Admin → Intake settings` configures the firm-wide retention policy.

- **Automatically delete finalized intake sessions** — boolean.
- **Delete after (days)** — 30 to 3650. Default 365.

When the toggle flips **off → on**, every finalized session's
`auto_delete_at` is backfilled to `MAX(now() + 7d, finalized_at + N
days)`. The 7-day floor prevents a sudden policy flip from immediately
purging a backlog of overdue sessions — admins get a week to notice
and revert.

When the toggle flips **on → off**, every `auto_delete_at` is cleared.
"Off means off."

### Per-session override

In the session detail panel:

- **Keep this session indefinitely** — sets `auto_delete_at=NULL`,
  exempts the session from auto-purge. Admin only.
- **Revert to firm policy** — re-derives `auto_delete_at` from the
  current firm setting (still applying the 7-day floor) or leaves NULL
  if the firm policy is currently off.

Both write `intake.session.retention_overridden` audit rows.

### What gets deleted

The hourly auto-purge ticker:

1. Writes `intake.session.auto_purged` to the audit log **first**.
2. Deletes on-disk encrypted blobs (`intake_files.stored_path` +
   `intake_pdfs.stored_path`).
3. Deletes the `intake_sessions` row; cascade clears
   `intake_files` / `intake_pdfs` / `intake_uploads_in_progress` /
   `intake_notifications_outbox` / `intake_session_archives`.

The audit row survives the cascade by construction — `audit_log` has
no FK back to `intake_sessions`. A purged session's history is
permanently traceable via Admin → Intake audit.

---

## Other settings

Same `Admin → Intake settings` panel:

- **Send to both email and SMS when both provided** — when a client
  enters both, the 28.10 ticker sends a receipt on each channel.
- **Cover page on assembled PDFs** — prepends a single-page cover to
  the Phase 28.9 assembled PDF with the client's contact info.
- **Concurrent conversion workers** — 1..16 (default 2). Tune up if
  you see PDF conversion backlog.
- **Per-file cap** / **Per-session cap** — tus upload bounds, in MB.
- **Staff daily-digest hour (local time)** — Phase 28.12 digest mode
  fires at this hour each day. 24-hour clock.
- **Maintenance mode** — top toggle. When on, public intake routes
  return 503; the staff app and admin routes are unaffected. Useful
  during a key rotation.

---

## Audit log usage

`Admin → Intake audit` is a pre-filtered view of the global audit log
where `action LIKE 'intake.*'`. Filters:

- **Event** dropdown — narrows to one specific action.
- **From** / **To** — date range.
- **Export CSV** — up to 10 000 matching rows.

### Event reference

| Event | When |
| --- | --- |
| `intake.card.updated` | Staff card title/bio/opt-in changed |
| `intake.card.headshot_updated` | Staff headshot uploaded |
| `intake.card.order_changed` | Admin reordered the public grid |
| `intake.session.created` | Anonymous form POST succeeded |
| `intake.session.finalized` | All files uploaded; conversion + notify enqueued |
| `intake.session.decrypted_on_view` | Staff opened the detail panel |
| `intake.session.archived` / `unarchived` | Per-user archive toggle |
| `intake.session.client_linked` / `unlinked` | Directory client association |
| `intake.session.auto_purged` | Retention sweep deleted the session |
| `intake.session.retention_overridden` | Admin used keep/revert |
| `intake.file.downloaded` / `intake.pdf.downloaded` | Staff downloaded a blob |
| `intake.link.created` | Send-a-link generator created a token |
| `intake.link.sent` / `send_failed` | Initial send result |
| `intake.link.resent` / `resend_failed` | Resend result |
| `intake.link.revoked` | Link flipped to 410 |
| `intake.token.validated` | Anonymous recipient successfully loaded `/intake/t/<token>` |
| `intake.token.rejected` | Token resolution failed; `details.reason` ∈ `bad_shape` / `not_found` / `revoked` / `expired` / `staff_unavailable` |
| `intake.client_notification.sent` / `failed` | Receipt email/SMS dispatch |
| `intake.staff_notification.sent` / `failed` | Staff alert email/in-app dispatch |
| `intake.pdf.conversion_failed` | After 3 retries; admins receive `admin.pdf_conversion_failed` email |
| `intake.settings.updated` | `Admin → Intake settings` PATCH |
| `intake.maintenance.toggled` | Maintenance mode flipped |
| `intake.key_rotation.dry_run` | Operator validated old/new keys (no mutation) |
| `intake.key_rotation.started` / `paused` / `resumed` / `completed` / `failed` | Operator-initiated rotation lifecycle |

---

## RBAC summary

| Action | Staff | Admin |
| --- | --- | --- |
| Edit own staff card | ✓ | ✓ |
| Edit another staff's card | — | ✓ |
| Reorder grid | — | ✓ |
| View own sessions | ✓ | ✓ |
| View all sessions / filter by staff | — | ✓ |
| Download files / PDF | own only | all |
| Create link for self | ✓ | ✓ |
| Create link assigned to other staff | — | ✓ |
| Revoke / resend any link | created or assigned | ✓ |
| Keep/revert per-session retention | — | ✓ |
| Edit firm settings | — | ✓ |
| Maintenance mode toggle | — | ✓ |
| Key rotation | — | ✓ |
| View intake audit | — | ✓ |
