# Vibe Connect — Addon Build Plan

## Phase 24: Client Requests & Document Collection

*Companion to `vibe-connect-build-plan.md`. The main plan (Phases 1–23) remains locked as-built; this document adds a structured request/response layer on top of the existing conversation, E2EE, portal, and bridge infrastructure. Nothing in this addon changes existing phase behavior — it extends.*

---

## Goal

Let firm staff send a client a structured checklist of items they need ("2024 Tax Documents"), and let the client upload documents, take photos, or reply to each item directly inside the existing E2EE conversation thread. Replace the back-and-forth email chase for tax organizers, monthly close documents, and engagement deliverables with a single audit-ready place where asks and responses live together.

## Scope

**In scope**

- Request lists scoped to a conversation (not a client) — matches staff mental model of engagements
- Per-item status tracking (pending → submitted → done, plus revision-requested)
- Three client response types per item: upload file, take photo, reply with note
- Firm-side request panel inside the conversation view
- Firm-side bulk dashboard across all clients
- Templates for common request lists (year-end, monthly close, new client onboarding)
- Scheduled reminders ("nudges") via existing email + SMS bridges
- Audit log entries for every state transition
- Integration with Phase 17 encrypted-attachment storage and Phase 16 ClamAV scanning

**Out of scope (v1)**

- Auto-matching free-text replies to items via content inspection (cleartext metadata linkage only — see Architectural Decisions)
- OCR-based field extraction from uploaded documents (possible future tie-in with `kisaes-ocr-server`)
- E-signature of received documents (different problem — covered by the Vibe MyBooks 8879 research, not here)
- Conditional/branching lists ("if answer is yes, ask for X")
- Direct integration with Vibe MyBooks / Vibe TB to auto-create transactions or tie to workpapers (tracked as a future cross-product addon)
- Multi-client shared lists (lists are always one-to-one with a conversation)

## Non-goals

- **Do not** re-implement auth. Clients already have magic-link + optional SSN/EIN gate from Phase 18.
- **Do not** re-implement upload plumbing. Phase 17 gives encrypted attachments, ClamAV scanning, and storage sharding.
- **Do not** re-implement delivery. Phase 20 (email-out) and Phase 23 (SMS-out) handle nudges and notifications.
- **Do not** introduce a separate `request_responses` table. Responses are messages.

---

## Architectural Decisions

### 1. Scope: conversation, not client

Lists belong to a conversation. A client with tax + bookkeeping + advisory work gets three distinct conversations, each with its own request lists. This matches how staff already think about engagements and inherits the Phase 11 membership model unchanged.

### 2. Responses piggyback on messages

A client fulfilling an item posts a normal message (with or without attachments) into the conversation, with `request_item_id` set in the message's cleartext metadata. No separate response table. This means:

- All Phase 17 E2EE, ClamAV, and audit guarantees apply automatically
- Staff see the structured checklist and the conversational context in one thread
- Message history remains the single source of truth

### 3. Item status is cleartext metadata

Status (`pending | submitted | done | revision`) lives outside the E2EE envelope, on the `request_items` row itself. The server can update `submitted_at` and show "3 of 5 done" without reading message contents. Attached *content* stays encrypted.

### 4. Text replies require explicit linkage

With E2EE, the server cannot read a free-text reply to infer which item it satisfies. Two options considered:

- **Option A**: Client UI sets `request_item_id` in the outgoing message before send. Requires the client to tap the item first.
- **Option B**: Client replies freely; staff manually ticks items done when they see the response.

**Decision: Option B for v1.** Less magical, fits CPA trust dynamics, avoids miscategorization. The client *can* tap an item first to auto-tag their message (Option A path available), but it's not required. If no linkage is set, staff get a "mark done" control next to the message in the panel.

### 5. No polling; reuse the existing socket

Request list updates flow over the existing Phase 4 Socket.io connection. A new `request.updated` event type carries the list/item ID and new status. No separate subscription channel.

### 6. Nudges are scheduled messages

A "nudge" button enqueues a BullMQ job that, at send time, posts an outbound message through the existing email (Phase 20) or SMS (Phase 23) bridge — same code path as a staff-authored message. No new delivery infrastructure.

### 7. HEIC photos: client-side conversion

iPhone camera output defaults to HEIC. Convert to JPEG client-side via `heic2any` (~500 KB gzipped) before upload. Keeps the server pipeline format-agnostic and saves round-trip bandwidth on mobile.

### 8. Authorization inherits conversation membership

If a staff user cannot see the conversation, they cannot see its requests. Same request-to-join flow from the Clients admin screen applies. No new permission primitive.

---

## Data Model

### New tables

```sql
-- One list per conversation may be active at a time; multiple may exist historically
CREATE TABLE request_lists (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT,
  due_date          DATE,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'completed', 'archived', 'cancelled')),
  created_by        UUID NOT NULL REFERENCES users(id),
  template_id       UUID REFERENCES request_templates(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX idx_request_lists_conversation ON request_lists(conversation_id);
CREATE INDEX idx_request_lists_status ON request_lists(status) WHERE status = 'active';

CREATE TABLE request_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id           UUID NOT NULL REFERENCES request_lists(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT,
  response_type     TEXT NOT NULL DEFAULT 'both'
                      CHECK (response_type IN ('file', 'text', 'both')),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'submitted', 'done', 'revision')),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  due_date          DATE,
  revision_note     TEXT,
  submitted_at      TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  completed_by      UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_request_items_list ON request_items(list_id, sort_order);
CREATE INDEX idx_request_items_status ON request_items(list_id, status);

CREATE TABLE request_templates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  item_specs        JSONB NOT NULL,   -- array of {title, description, response_type, sort_order, default_due_offset_days}
  created_by        UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at       TIMESTAMPTZ,
  UNIQUE (firm_id, name)
);
```

### Extended tables

```sql
-- Add nullable FK to messages for item linkage
ALTER TABLE messages ADD COLUMN request_item_id UUID REFERENCES request_items(id);
CREATE INDEX idx_messages_request_item ON messages(request_item_id) WHERE request_item_id IS NOT NULL;

-- Optional: flag a message as the system-generated "item submitted" event
ALTER TABLE messages ADD COLUMN system_event_type TEXT
  CHECK (system_event_type IN ('request_item_submitted', 'request_item_revision', 'request_item_done', 'request_list_created', 'request_nudge_sent') OR system_event_type IS NULL);
```

### Item state machine

```
┌─────────┐   client uploads/replies    ┌───────────┐
│ pending │ ─────────────────────────▶  │ submitted │
└─────────┘                             └─────┬─────┘
     ▲                                        │
     │ staff requests revision                │ staff marks done
     │                                        ▼
     │                                  ┌──────────┐
     └──────── ┌──────────┐ ◀───────────│   done   │
              │ revision │             └──────────┘
              └──────────┘
                   │
                   │ client uploads/replies
                   ▼
              ┌───────────┐
              │ submitted │
              └───────────┘
```

Transitions:

- `pending → submitted` — automatic on client message with `request_item_id` set and (for `response_type=file` or `both`) at least one attachment
- `submitted → done` — manual by staff ("Mark done" button on message or in panel)
- `submitted → revision` — manual by staff with required note; posts a system message in the thread
- `revision → submitted` — client uploads/replies again (same rules as `pending → submitted`)
- `done → revision` — allowed; reopens the item

---

## API Contract

All routes under `/api/v1` and protected by existing session middleware. Conversation membership is enforced on every endpoint.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/conversations/:id/request-lists` | List all lists for a conversation (active + historical) |
| `POST` | `/conversations/:id/request-lists` | Create a new list (optionally from `template_id`) |
| `GET` | `/request-lists/:id` | List with items |
| `PATCH` | `/request-lists/:id` | Update title, description, due date, status |
| `DELETE` | `/request-lists/:id` | Cancel (soft delete via status) |
| `POST` | `/request-lists/:id/items` | Add item |
| `PATCH` | `/request-items/:id` | Update title, description, response_type, sort_order, due date |
| `DELETE` | `/request-items/:id` | Remove item (only if `pending`) |
| `POST` | `/request-items/:id/mark-done` | Mark item done (staff only, from submitted or revision) |
| `POST` | `/request-items/:id/request-revision` | Reopen with required `note` |
| `POST` | `/request-items/:id/link-message` | Attach an existing message to an item retroactively |
| `GET` | `/firms/:id/requests/dashboard` | Bulk view across all conversations |
| `POST` | `/request-lists/:id/nudge` | Enqueue a reminder via email/SMS bridge |
| `GET` | `/firms/:id/request-templates` | Template CRUD |
| `POST` | `/firms/:id/request-templates` | |
| `PATCH` | `/request-templates/:id` | |
| `DELETE` | `/request-templates/:id` | |

### Socket events (over existing Phase 4 socket)

| Event | Payload | Direction |
|-------|---------|-----------|
| `request_list.updated` | `{list_id, conversation_id, status, progress}` | server → clients |
| `request_item.updated` | `{item_id, list_id, status, updated_at}` | server → clients |
| `request_item.message_linked` | `{item_id, message_id}` | server → clients |

---

## Phased Build Plan

### Phase 24.1 — Schema, migrations, types (Day 1)

**Depends on:** Phases 1, 11, 17 complete.

- [ ] Write Drizzle migration for `request_lists`, `request_items`, `request_templates`
- [ ] Write Drizzle migration for `messages.request_item_id` and `messages.system_event_type` columns + indexes
- [ ] Generate TypeScript types from Drizzle schemas
- [ ] Add zod validators for API input shapes in `shared/validators/requests.ts`
- [ ] Add fixture factory functions in `server/test/factories/requests.ts`
- [ ] Run migration against dev DB and verify FK cascade behavior (deleting a conversation cascades to lists, items, and nulls out `request_item_id` on messages)

### Phase 24.2 — Core API & state machine (Days 2–3)

**Depends on:** Phase 24.1.

- [ ] Implement `requests.service.ts` with all state-transition methods (`createList`, `addItem`, `markSubmitted`, `markDone`, `requestRevision`, `linkMessage`)
- [ ] Each transition writes an `audit_log` entry using Phase 6 primitives
- [ ] Implement all REST endpoints from the API Contract table
- [ ] Middleware: inherit Phase 11 conversation-membership authorization on every route
- [ ] Wire message-creation pipeline: if outgoing message has `request_item_id`, run auto-submit logic (check response_type + attachment count, transition item to `submitted`, emit socket event)
- [ ] Emit `request_list.updated` and `request_item.updated` socket events on every state change
- [ ] Unit tests covering every transition and every rejection path (non-member, wrong role, invalid transition)
- [ ] Integration test: end-to-end create list → client reply → staff mark done

### Phase 24.3 — Firm panel in conversation view (Days 4–5)

**Depends on:** Phase 24.2.

- [ ] New `<RequestPanel>` component slot on the right side of the conversation view (Phase 5)
- [ ] Toggle button in conversation header: "Requests" icon, active when open
- [ ] Remember open/closed state per user in `user_preferences` table
- [ ] Progress bar showing done/total ratio
- [ ] Item list with status pills (pending/submitted/needs-review/done/revision) — use mockup colors
- [ ] Inline "Add item" affordance at bottom of list
- [ ] Per-item actions menu: Edit, Mark done, Request revision (with required note), Delete (pending only)
- [ ] "Request revision" modal with note field; on submit, post a system message into the thread referencing the item
- [ ] When a linked message arrives (via socket), scroll to the item and briefly highlight it
- [ ] Staff "Mark done" quick-action appears next to any message with `request_item_id` set, where the item is `submitted`
- [ ] "New list" button opens a modal with choices: blank list, or apply template (Phase 24.6 dependency — stub template picker for now)
- [ ] E2E test with Playwright: create list, add 3 items, simulate client reply, mark done, verify panel updates live

### Phase 24.4 — Client portal Requests tab (Days 6–7)

**Depends on:** Phase 24.2, Phase 18 (client portal from main plan).

- [ ] New `Requests` tab in the portal nav beside Messages and Docs
- [ ] Badge count showing items with status `pending` or `revision`
- [ ] List view: active request lists with title, due date, progress bar, x/y count
- [ ] Tap into list → full item view with status pills
- [ ] Item tap → bottom-sheet with three actions: Take photo, Upload file, Reply with note (per mockup view B)
- [ ] "Take photo" action uses `<input type="file" accept="image/*" capture="environment">` — no custom camera UI
- [ ] "Upload file" action uses standard file picker
- [ ] "Reply with note" action opens the compose screen with the item pre-linked
- [ ] Encryption chip on bottom sheet reminds client that submissions are E2EE
- [ ] Offline queue: if the client taps submit while offline, the service worker queues the upload and retries on reconnect (use existing Phase 19 service-worker infrastructure)
- [ ] Mobile-first responsive layout; test on actual iPhone Safari and Android Chrome (do not trust DevTools emulation alone)
- [ ] E2E test with Playwright mobile viewport: view list → tap item → take photo path → submit → verify item shows as `submitted` on firm side

### Phase 24.5 — Upload & submit flow with HEIC handling (Days 8–9)

**Depends on:** Phase 24.4, Phase 17 (encrypted attachments).

- [ ] Add `heic2any` to client portal bundle (dynamic import — only load when a HEIC file is selected)
- [ ] Detect HEIC/HEIF by MIME or magic bytes; convert to JPEG at 90% quality before upload
- [ ] Show conversion progress indicator for files >5 MB
- [ ] Multi-attachment submission: allow 1–10 files per submission (config limit)
- [ ] Per-file status in preview area (per mockup view C): filename, size, encryption status, scan status, remove (X)
- [ ] Submit button disabled until at least one attachment (if response_type=file) or at least text (if response_type=text) or either (if response_type=both) is present
- [ ] On submit, post one message with all attachments and linked `request_item_id`
- [ ] Wire into Phase 17 ClamAV scan queue; if scan fails, surface a specific error to the client and revert item to `pending` (or previous state)
- [ ] Show "Encrypted · scanned ✓" chip per attachment after successful scan
- [ ] Client upload retry with exponential backoff; abandon after 3 failures with a clear error
- [ ] E2E test with real HEIC sample fixture

### Phase 24.6 — Templates & bulk dashboard (Days 10–11)

**Depends on:** Phase 24.3, Phase 24.4.

- [ ] Template CRUD API from Phase 24.2 now surfaced in firm admin UI
- [ ] Template editor: name, description, item rows (title, description, response_type, default_due_offset_days), drag-to-reorder
- [ ] Seed 3 default templates per new firm: "Year-end tax documents (1040)", "Monthly bookkeeping close", "New client onboarding"
- [ ] "Apply template" flow from Phase 24.3 list-creation modal: pick template → preview items → set list due date → due dates on items computed from `default_due_offset_days` relative to list due → create
- [ ] Bulk dashboard route `/requests` in firm app (per mockup view 03)
  - [ ] Table: client avatar/name, list title, progress bar+count, due chip (overdue/warning/ok/complete), last activity, action button
  - [ ] Filters: All / Mine / Overdue / Stale >3d
  - [ ] Sort defaults: overdue first, then due soonest, then stale last-activity
  - [ ] Row action button shows context-appropriate label (Call now / Nudge / Open / Review / Close list)
  - [ ] Click row → deep-link to conversation with request panel auto-opened
- [ ] E2E test: create template, apply to conversation, verify items land with correct due dates

### Phase 24.7 — Nudges & reminders (Days 12–13)

**Depends on:** Phase 24.2, Phase 20 (email bridge), Phase 23 (SMS bridge).

- [ ] "Send nudge" button in request panel footer and in bulk dashboard row actions
- [ ] Nudge picker modal: channel (in-app + email, email only, SMS only, all), optional custom message override, send time (now / schedule)
- [ ] Scheduled nudges enqueued as BullMQ jobs with firm/conversation/list context
- [ ] Nudge worker at send time:
  - [ ] Check list is still `active` and has `pending` or `revision` items (skip if complete)
  - [ ] Build default message: "Hi {client}, a reminder that {N} items are still needed for {list.title}. Due {due_date}. Open: {portal_url}"
  - [ ] Route through Phase 20 email bridge or Phase 23 SMS bridge as selected
  - [ ] Post a `request_nudge_sent` system message into the thread for audit
- [ ] Auto-nudge (opt-in per firm): 72 hours before due, 24 hours before due, day-of — configurable in firm settings
- [ ] Nudge history visible in the request panel: "Last nudge sent Tue 4:02 PM via email"
- [ ] Rate limit: max 3 nudges per list per 24 hours (prevents accidental spam)
- [ ] Respect client's existing bridge preferences (Phase 23 opt-in record)
- [ ] E2E test: schedule a nudge 1 minute out, verify worker fires and posts system message

### Phase 24.8 — Audit log, notifications, polish (Day 14)

**Depends on:** Phase 24.2–24.7.

- [ ] Verify every transition writes an audit entry: `request_list.created`, `request_list.updated`, `request_item.created`, `request_item.submitted`, `request_item.marked_done`, `request_item.revision_requested`, `request_list.nudge_sent`, `request_list.completed`
- [ ] Audit log filter UI gains a "Requests" category
- [ ] In-app notifications (Phase 9): new item submitted, all items complete, revision requested (for client side)
- [ ] Email digest (opt-in): daily summary of items submitted across all conversations — uses Phase 20 bridge
- [ ] Dashboard widget on firm home: "Attention needed" card — count of lists overdue, count of items in `submitted` awaiting review
- [ ] Client portal home: "You have {N} items pending" banner with deep-link into the list

### Phase 24.9 — Documentation & handoff (Day 15)

**Depends on:** all prior phases.

- [ ] Admin guide: how to create a list, apply a template, interpret statuses, send nudges, configure auto-nudge
- [ ] Client-facing help page: "How to respond to a request" with screenshots
- [ ] Firm setup guide: recommended templates for different firm types (tax-focused, bookkeeping, mixed practice)
- [ ] API reference for requests endpoints (in existing docs)
- [ ] Update `CLAUDE.md` with new schema, completed Phase 24 section, any deviations
- [ ] Record 2-minute Loom walkthrough for customer-facing release notes

---

## Summary Sizing

| Phase | Title | Days |
|-------|-------|------|
| 24.1 | Schema, migrations, types | 1.0 |
| 24.2 | Core API & state machine | 2.0 |
| 24.3 | Firm panel in conversation view | 2.0 |
| 24.4 | Client portal Requests tab | 2.0 |
| 24.5 | Upload & submit flow (HEIC) | 2.0 |
| 24.6 | Templates & bulk dashboard | 2.0 |
| 24.7 | Nudges & reminders | 2.0 |
| 24.8 | Audit log, notifications, polish | 1.0 |
| 24.9 | Documentation & handoff | 1.0 |
| **Total** | | **15.0 days** |

**Total checklist items: ~95**

Calendar time including review/QA: **3 weeks** of focused work.

---

## Integration Checklist

Items that touch code outside the requests feature — verify each before shipping.

- [ ] `messages` table migration reviewed for impact on existing queries (every SELECT should be unaffected by new nullable columns)
- [ ] Phase 6 audit log renderer knows how to display the new event types
- [ ] Phase 11 membership-change events trigger re-authorization on request panel open (if a user is removed from a conversation, their open request panel should close)
- [ ] Phase 17 attachment retention / crypto-shredding still covers attachments linked to request items — verify reaper doesn't skip them
- [ ] Phase 20 email bridge templates include a new "request nudge" template with correct SPF/DKIM alignment
- [ ] Phase 23 SMS bridge character budget tested with longest default nudge message (watch for segmentation)
- [ ] Phase 19 service worker updated to include request portal routes in its cache scope and offline queue
- [ ] Phase 4 socket client handles the three new event types
- [ ] Admin settings page gains a "Requests" section for auto-nudge cadence and default template assignments
- [ ] Rate limits on nudge endpoint added to Phase 8 rate-limit config
- [ ] Backup/restore test (Phase 25 if implemented, or existing Duplicati config): restore a DB with active request lists and verify items, linkages, and status all survive

---

## Watch Items / Gotchas

- **iOS Safari large-upload failures.** Mobile networks drop uploads above a few MB. Use chunked upload from day one (Phase 17 should already, but confirm client portal uses the chunked endpoint, not a single POST).
- **HEIC ambiguity.** Some Android devices return HEIC too. Detection should be by magic bytes, not extension.
- **Race condition on rapid taps.** Client taps an item repeatedly to open the bottom sheet — debounce at the UI layer, idempotency on the server via a client-supplied UUID in the submission.
- **"Mark done" before scan completes.** Staff can hit Mark Done on a submitted item whose attachment is still scanning. Allow it, but if the scan later fails, revert to `revision` with a system note "Attachment failed virus scan — please re-upload."
- **Template edits affecting live lists.** Editing a template does NOT alter any list already created from it. Template → list is a one-time copy. Call this out in the admin guide.
- **Nudge spam via auto-nudge + manual nudge on the same day.** Rate limit (3/24h/list) applies to both sources.
- **Cascade on conversation deletion.** Deleting a conversation wipes lists and items, and nulls out `request_item_id` on messages. This is correct behavior for archive/restore but confirm backup captures lists before cascade fires.
- **Auditor / peer review export.** CPA peer reviewers may want to see the full chain: list created → items → client submissions → staff marked done. Make sure the Phase 6 audit export includes the requests events in chronological order.
- **Client receives nudge about a completed list.** The worker must re-check list status at send time, not just at enqueue time. Already in Phase 24.7 checklist; do not skip.

---

## Open Questions Before Kickoff

1. **Default auto-nudge cadence** — should the default be ON or OFF for new firms? (Recommend OFF; opt-in per firm to avoid surprise client messages.)
2. **Item reordering** — drag-to-reorder in the panel v1, or defer to 24.6b? (Recommend v1, small cost.)
3. **Does a list need a single "owner" staff member** distinct from `created_by`? (Recommend yes if you expect lists to be reassigned; otherwise just use conversation lead from Phase 11.)
4. **Archive policy for completed lists** — auto-archive after 30 days, or stay visible until manually archived? (Recommend auto-archive after 90 days, with an "Archived" filter in bulk dashboard.)
5. **Client-side "See receipt" surface** — do clients get a confirmation view after submitting, or is the status pill update enough? (Recommend a brief toast; persistent history is the Messages tab.)
