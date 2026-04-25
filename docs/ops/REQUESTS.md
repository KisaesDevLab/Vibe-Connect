# Phase 24 — Client Requests & Document Collection (Admin Guide)

## What it is

Structured checklists that live inside an existing E2EE conversation. Staff post a list ("2024 Tax Documents") with one or more items; the client responds via the portal by uploading files, taking photos, or replying with text. Status surfaces server-side so progress is visible without breaking the encryption invariants — the *content* of every response stays end-to-end-encrypted.

## Crypto split — what's cleartext, what's E2EE

This trade-off is load-bearing; document it for any peer reviewer or compliance auditor.

| Field | Storage | Why |
|---|---|---|
| `request_lists.title` | **cleartext** | Used in nudge body templates ("Reminder: 3 items pending in *2024 Tax Documents*") and rendered by the portal before the conversation key is unwrapped. |
| `request_lists.description` | **cleartext** | Same rationale. |
| `request_lists.due_date` / `status` | **cleartext** | Calendar / state-machine values — not content. |
| `request_items.title_ciphertext` | **E2EE** under conversation key | Item-level asks (e.g. "W-2 forms") may be sensitive. |
| `request_items.description_ciphertext` | **E2EE** | Same. |
| `request_items.revision_note_ciphertext` | **E2EE** | Staff revision notes contain the actual back-and-forth. |
| `messages.ciphertext_meta.requestItemId` | **cleartext metadata** | Linkage from a message to an item. |
| `request_templates.item_specs` | **cleartext** | Firm-internal config; encryption happens at apply-time on the staff client. |

Encryption uses the **conversation's content key** (X25519-wrapped, XChaCha20-Poly1305-sealed) — the same key already wrapped per-recipient for messages. No new key, no new wrap.

## Lifecycle

```
                  staff creates list
                          │
                          ▼
                  ┌───────────────┐
                  │   pending     │
                  └───────┬───────┘
                          │ client posts message with
                          │ ciphertextMeta.requestItemId
                          ▼
                  ┌───────────────┐
                  │   submitted   │ ← staff sees in panel + dashboard
                  └─┬───────────┬─┘
                    │           │
   staff requests   │           │ staff marks done
   revision (with   │           │
   E2EE note)       │           │
                    ▼           ▼
            ┌───────────┐   ┌────────┐
            │ revision  │   │  done  │
            └─────┬─────┘   └────┬───┘
                  │              │ all items done →
                  │              │ list auto-completes
                  └─→ submitted  │
                       (loop)    │
                                 ▼
                          (list completed)
```

## Creating a list

1. Open a conversation → click **Requests** in the header.
2. Click **+ New** in the panel that opens.
3. Optional: pick a template from the dropdown to pre-fill the items.
4. Type the list title (cleartext), an optional description, due date, and at least one item.
5. Each item: title (E2EE), description (E2EE, optional), response type (file / text / both), per-item due date (optional).
6. Click **Create list**.

## Templates

* **Admin → Templates** has full CRUD (Create / Edit / Archive). Three are seeded on a fresh appliance: *Year-end tax documents (1040)*, *Monthly bookkeeping close*, *New client onboarding*.
* Editing a template **does not** alter lists already created from it. Apply is a one-time copy.
* Archiving a template hides it from the picker but doesn't delete; the partial unique index on `name` lets you reuse the same name later.

## Statuses (cleartext)

| Status | Meaning |
|---|---|
| **pending** | Asked but no response yet. |
| **submitted** | Client replied / uploaded; staff hasn't reviewed. |
| **done** | Staff accepted the response. |
| **revision** | Staff asked for a re-do. The note is E2EE; clients see it in their panel. |

## Nudges

### Manual

In the Requests panel of an active list with open items, click **Nudge**. The reminder rides the existing scheduled-message ticker → fans out via the configured email + SMS providers (respecting per-recipient prefs). Cap: **3 nudges per list per 24h** (manual + auto combined).

### Auto-cadence

**Default OFF.** Enable in **Admin → Settings → Auto-nudge for request lists**:

* **Enable** checkbox.
* **Offsets, in hours before due** — comma-separated. Default `72, 24, 0` (3 days, 1 day, day-of).

A list with `due_date` set will get one nudge enqueued per matching offset, fired on the hour boundary. A list that completes between schedule and fire is silently dropped (audited as `request.nudge_skipped`).

### Skip rules

A nudge fires only if, **at fire time**, the list is still `active` AND has at least one `pending` or `revision` item. This means:

* Cancelling a list drops queued nudges.
* Marking the last item done drops queued nudges.
* Manually nudging a completed list is rejected by the API (409).

## Audit trail

Every transition writes a row to `audit_log`. Filter: **Admin → Audit log → Requests**. Action names:

| Action | Triggered by |
|---|---|
| `request.list_created` | New list (manual or template) |
| `request.list_updated` | Title / due-date / status patched |
| `request.list_cancelled` | Cancel button |
| `request.list_completed` | Last item marked done |
| `request.item_created` | Item added (initial or via "+ Add item") |
| `request.item_updated` | Item ciphertext / response_type / sort_order patched |
| `request.item_deleted` | Pending item removed |
| `request.item_submitted` | Auto-flip from a linked message |
| `request.item_marked_done` | Staff "Mark done" |
| `request.item_revision_requested` | Staff "Request revision" |
| `request.item_link_rejected` | Client tampered with `ciphertextMeta.requestItemId` (cross-conversation) |
| `request.item_scan_failed` | Attachment scan failed; auto-revert to `revision` |
| `request.message_linked` | Retro-link via "Link message" |
| `request.template_created` / `request.template_updated` / `request.template_archived` | Templates CRUD |
| `request.nudge_scheduled` | Manual or auto enqueue |
| `request.nudge_sent` | Ticker dispatched the nudge |
| `request.nudge_skipped` | Ticker dropped a stale nudge with a `reason` |

Export the filtered set to CSV from the same page.

## Bulk dashboard

`/requests` (also linked from the header **Requests** button). Tab filters: **All / Mine / Overdue / Stale > 3d**. Rows show conversation, list title, progress, due chip, last activity, and an Open → link. Sort is fixed: active first, due-date ASC, updated_at DESC.

## What's E2EE — what isn't

* **Message bodies** the client uploads in response to an item: E2EE under the conversation key. Server stores ciphertext only.
* **Attachments**: client-side encrypted, server-side ClamAV-scanned (the scan reads the encrypted bytes; clamd's pattern matching catches known-bad signatures even without decryption).
* **Item titles + descriptions + revision notes**: E2EE under the conversation key.
* **List titles + descriptions, status, due dates, item counts, audit metadata**: cleartext server-side. This is the deliberate trade-off that lets the dashboard, nudges, and progress bars work without per-row decryption.

## Recovery model

* **Cascade on conversation deletion**: lists + items wipe via `ON DELETE CASCADE`. Any surviving system message that referenced an item via `ciphertextMeta.requestItemId` becomes a dangling pointer; the panel quietly ignores it.
* **Templates** survive client/conversation deletion (firm-scoped).
* **Crypto-shredding** of an attachment (retention sweep) doesn't touch the linked item's status — the audit row still shows the original `submitted` event for an attachment that's now content-shredded.

## Migrations

| File | Adds |
|---|---|
| `20260425000001_request_lists.js` | `request_lists`, `request_items`, `request_templates` |
| `20260425000002_firm_auto_nudge.js` | `firm_settings.auto_nudge_enabled`, `firm_settings.auto_nudge_offsets_hours` |

Apply via the standard appliance flow (`yarn workspace @vibe-connect/server migrate` or the docker-compose run-once container).

## Seed

`02_request_templates.js` ships three default templates. Idempotent — safe to re-run; skips templates whose name is already taken (active).

## Operational gotchas

* **Cleartext list titles** are visible to anyone with DB access. CLAUDE.md's `server stores ciphertext only` rule is loosened here for chrome-level fields. If a customer's threat model requires zero cleartext metadata for engagement names, switch templates to encrypted titles in v2 (will require a per-conversation symmetric key for templates too — non-trivial).
* **Single-POST attachment cap** is the existing 25 MB body limit — chunked upload is a v2 candidate.
* **Auto-nudge fires at the UTC hour boundary**. A nudge that lands at 04:00 in a recipient's local TZ is gated by the existing SMS quiet-hours config (`firm_settings.sms_quiet_start_hour` / `sms_quiet_end_hour`). Email has no quiet-hours equivalent yet.
* **Rate limit (3/24h/list)** is enforced at enqueue time and counts both manual + auto nudges. A misconfigured offsets list (e.g. `[1, 2, 3, 4]`) burns through the cap on day one.
* **HEIC** is in the allowed MIME list server-side. Browser preview after decrypt depends on the staff browser; non-Safari may render blank, in which case the chip becomes a download-only link.

## Tests

Run via `yarn workspace @vibe-connect/server test`:

* `requests-service.test.ts` — pure state-machine + audit coverage (~25 tests)
* `requests.test.ts` — REST endpoints + post-insert hook + dashboard (~13 tests)
* `auto-nudge.test.ts` — manual nudge, rate limit, ticker skip-on-complete, sweeper offset math + idempotency (9 tests)
