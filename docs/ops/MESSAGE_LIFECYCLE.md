# Message lifecycle — edit, delete, timed self-destruct

Phase 27 added three sender-side controls on the staff app: edit, delete,
and an optional per-message self-destruct timer. None of these are exposed
to the client portal — the portal renders the resulting state (placeholder,
"edited" indicator) but never edits or deletes.

## Quick reference

| Control | Who can | Window | Recipient sees | Admin sees |
|---|---|---|---|---|
| Edit | Sender (staff) | `firm_settings.message_edit_window_minutes` (0 disables) | "edited" indicator, latest body | Every prior ciphertext via Admin → Message history |
| Delete | Sender (staff) | Always (no window) | "Message deleted" placeholder | Original ciphertext preserved on the row |
| Self-destruct | Sender (staff) | Per-message dropdown, capped by `firm_settings.message_destruct_max_seconds` | "Message deleted" placeholder after timer fires | Original ciphertext preserved (same as manual delete) |

Edit/delete rows always live in `messages` with `edited_at` / `deleted_at`
set; the bytes stay put for admin recovery via the existing wrapped-key
chain. Crypto-shred only happens if the firm's retention window claims the
row (separately, via `services/retention.ts`).

## Edit window

- Configured at **Admin → Settings → Message lifecycle → Edit window**.
- 0 disables edits entirely (send-only mode for compliance-strict firms).
- Default 15 minutes preserves pre-Phase-27 behaviour.
- The edit route refuses past the window with `400 edit_window_expired`.
- Each edit:
  - Snapshots the prior `(ciphertext, ciphertext_meta, content_key_version,
    replaced_by_user_id)` into `message_edits` inside the same transaction.
  - Audits `message.edited`.
  - Broadcasts `message:edit` so connected clients refetch.
- The "edited" indicator on the bubble is the only recipient signal. Prior
  versions are admin-only.

## Delete

- Available on the sender's own bubbles, no time window.
- Soft-delete only: sets `deleted_at = NOW()`. The ciphertext bytes stay on
  the row for admin recovery.
- Recipients see "Message deleted by Alice at 14:23" in place of the
  bubble. The row remains in the messages list response with stripped
  ciphertext + null meta on the wire.
- Audits `message.deleted`.
- Broadcasts `message:delete` so connected clients replace the bubble with
  the placeholder live.

## Timed self-destruct

- Enabled firm-wide via **Admin → Settings → Message lifecycle → Allow
  self-destruct timer**. Default ON.
- Per-message dropdown in compose: Off / 5 min / 1 hour / 1 day / 7 days,
  capped at `messageDestructMaxSeconds` (default 7 days, ceiling 30 days).
- Server enforces the cap and the kill switch on POST; tampered clients
  cannot bypass.
- Trigger: the **first non-sender read**. Sender self-reads do not arm the
  timer. Subsequent reads do not move it (idempotent
  `WHERE destruct_at IS NULL`).
- Fire path: `services/destructMessages.ts` runs every 30s. A single
  `UPDATE ... RETURNING` claims and soft-deletes due rows atomically.
- Audits:
  - `message.destruct_armed` when the read endpoint stamps `destruct_at`.
  - `message.destructed` when the ticker fires the soft-delete.
- Broadcasts `message:delete` (re-uses the existing channel — UI semantics
  are identical for recipients).
- After fire, the row is admin-recoverable just like a manual delete.
  Crypto-shred follows the same retention rules as everything else.

### Best-effort caveat

Self-destruct is **not** a true ephemeral-messaging guarantee. Once a
recipient device has decrypted the message, the plaintext may have been
written to:

- The FlexSearch index in the recipient's encrypted IndexedDB.
- The browser's scrollback buffer / DOM.
- A screenshot or copy/paste.
- Operating-system swap or logs.

The threat model spells this out
(`docs/THREAT_MODEL.md` → "Phase 27 deltas"). Compose UI surfaces it as
"Self-destruct after viewed" with a tooltip. Treat the feature as a
"reduce server-side liability" control rather than an "untraceable
disappearing message" control.

## Admin recovery — Message history

- **Admin → Message history** tab takes a message ID and pulls
  `GET /admin/messages/:id/history`.
- The bundle returns the live row + every prior `message_edits` snapshot +
  the conversation's wrapped-key bundle. Identical decrypt mechanics to
  `/admin/export`.
- For an admin already enrolled on a member device, the wrapped keys
  unwrap directly. For a non-member admin, the firm recovery phrase
  unwraps the firm-keyed entry and from there the conversation key. (Not
  yet wired into the Message history UI — admins use the existing
  Export decrypt pathway for now.)
- Rate-limited 30 requests / hour / admin.
- Audits `admin.message_history_viewed` with `editCount` + `deleted` flag.

## Audit actions added

| Action | Emitter | Target | Notes |
|---|---|---|---|
| `message.edited` | PATCH /conversations/messages/:id | message id | Pre-edit ciphertext lives in `message_edits` |
| `message.destruct_armed` | POST /conversations/messages/:id/read (and portal equivalent) | message id | Includes `fireAt` and `afterViewSeconds` |
| `message.destructed` | destructMessages ticker | message id | Distinct from `message.deleted` so admins can filter automated vs manual purges |
| `admin.message_history_viewed` | GET /admin/messages/:id/history | message id | Includes `editCount` + `deleted` flag |

`message.deleted` already existed pre-Phase-27.

## Operator runbook

### "A staffer is asking for the original of a deleted/edited message"

1. Get the message id from the staffer's bubble (Admin → Audit log
   `message.deleted` / `message.edited` rows include the target id).
2. Open Admin → Message history, paste the id, click Load.
3. Download the JSON bundle. Decrypt offline with the existing recovery
   phrase + the conversation's wrapped key (or directly in-browser if
   you're already enrolled on a member device — future UI improvement).
4. Audit row `admin.message_history_viewed` confirms the lookup happened.

### "Self-destruct messages aren't disappearing"

Likely causes, in priority order:

1. **No first non-sender read yet.** `destruct_at` is NULL until a
   recipient reads the message. Sender self-reads don't arm. Confirm:
   ```sql
   SELECT id, destruct_after_view_seconds, destruct_at, deleted_at
   FROM messages WHERE id = '<id>';
   ```
2. **Ticker not running.** Check
   `select * from pg_stat_activity where query like '%destruct_at%';`
   while a destruct should be firing. The ticker logs `destruct_tick_failed`
   on errors.
3. **Firm setting flipped off.** Already-armed messages still fire even
   when `message_destruct_enabled` is later set to false; the toggle only
   gates new sends.
