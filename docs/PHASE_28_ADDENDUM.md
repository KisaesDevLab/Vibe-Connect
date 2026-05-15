# Vibe Connect — Phase 28 Addendum: Vibe File Transfer (Intake)

**Status:** **Sub-phases 28.0–28.17 shipped (2026-05-15).** Operator + firm-admin runbooks live at [docs/ops/INTAKE.md](./ops/INTAKE.md) and [docs/ops/INTAKE_FIRM_ADMIN.md](./ops/INTAKE_FIRM_ADMIN.md). Two follow-up items deliberately deferred from 28.17: Playwright E2E suite and k6 load test (both require new CI infrastructure scoped to the intake feature).
**Scope:** Anonymous-friendly file intake feature added to Vibe Connect
**Estimated size:** 18 sub-phases (28.0 pre-step + 17 build phases) · ~265 checklist items
**Encryption posture:** Server-side encryption at rest with firm-held libsodium key (NOT E2EE — see ADR-028)
**Stack notes:** Knex migrations, in-process `setInterval` tickers (no Redis/BullMQ), nginx single-app ingress, no CLI binary, in-tree tus 1.0.0 (no `@tus/server`), reuses existing `audit_log` table, ALTERs existing singleton `firm_settings`.
**Public routes (mounted at nginx + Express public section):** `/intake` (staff card grid), `/intake/:staffId` (intake form for selected staff), `/intake/t/:token` (tokenized staff-sent link)
**Authenticated routes (staff SPA `apps/web`):** `/app/intake` (received uploads), `/app/intake/links` (send-a-link), `/app/intake/audit` (filtered view over the global `audit_log` table for `action LIKE 'intake.%'`, admin only), `/app/settings/intake` (firm retention settings)
**New SPA workspace:** `apps/intake` — fourth Vite + React 18 + Tailwind bundle, served by nginx alongside `apps/web` and `apps/portal`.
**Admin operations:** HTTP routes under `/admin/intake/*`; no CLI binary exists in this repo.

---

## Sub-phase 28.0 — ClamAV Sidecar Pre-step

**Goal:** Make the existing `apps/server/src/services/clamav.ts` wire-protocol client usable by adding the missing container. Required before any other sub-phase because every uploaded file is virus-scanned.

**Checklist:**
- [ ] Add a `clamav` service to `infra/docker/docker-compose.yml`: `image: clamav/clamav-debian:stable`, named volume `clamav_db` mounted at `/var/lib/clamav` so signature DB persists across restarts, healthcheck via `clamdcheck.sh` or socket-banner probe, restart policy matching the other services.
- [ ] Add `clamav` to `infra/docker/docker-compose.prod.yml` with image pin + memory/CPU limits matching the other prod services.
- [ ] In `.env.example`, default `CLAMD_HOST=clamav` and `CLAMD_PORT=3310` (currently unset). Keep `ALLOW_UNSCANNED_UPLOADS=1` as the dev escape hatch.
- [ ] Verify the server's startup ClamAV probe works: log line `clamav.ready` (or equivalent) appears when the sidecar is healthy.
- [ ] Write a one-off Vitest test that calls `services/clamav.ts:scanBuffer(Buffer.from(EICAR_STRING))` against the running container and asserts `status === 'infected'`. Skip in CI if `CLAMD_HOST` unset.
- [ ] Update `infra/docker/README` (or create a one-paragraph note where the other services are documented) explaining the ClamAV resource footprint and that signature DB updates happen inside the container via the upstream image's freshclam.

**Acceptance:**
- `yarn compose:up` boots the new `clamav` service alongside `postgres`, `app`, `nginx`.
- `docker compose logs clamav` shows daemon ready within 60 seconds of cold start.
- EICAR scan test returns `{ status: 'infected', signature: 'Eicar-Test-Signature' }` (or the exact ClamAV variant).
- `yarn server:dev` against `compose:up` shows `clamav.ready` in logs.

---

## Sub-phase 28.1 — Schema & Migrations

**Goal:** Add all database tables and `users` + `firm_settings` augmentations required for intake. Single Knex migration file.

**Checklist:**
- [ ] Knex migration `apps/server/src/db/migrations/20260514000001_intake.js` with paired `up` and `down`.
- [ ] In the same migration: add columns to `users` — `show_on_intake_card` (boolean, default false, not null), `intake_card_order` (integer, nullable), `intake_card_bio` (text, nullable, server-side enforced length 280), `intake_card_headshot_url` (text, nullable), `intake_card_title` (text, nullable, server-side enforced length 60).
- [ ] In the same migration: ALTER `firm_settings` to add intake config columns — `intake_auto_delete_enabled` (boolean, default false), `intake_auto_delete_after_days` (integer, default 365), `intake_send_to_both_channels` (boolean, default true), `intake_max_file_bytes` (bigint, default 52428800 = 50MB), `intake_max_session_bytes` (bigint, default 262144000 = 250MB), `intake_conversion_concurrency` (integer, default 2), `intake_include_cover_page` (boolean, default true), `intake_digest_hour_local` (integer, default 8), `intake_maintenance_mode` (boolean, default false). No new `firm_settings_intake` table.
- [ ] Create `intake_sessions` — id (uuid pk), staff_id (uuid fk users), source (enum 'public'|'staff_link'), token_id (uuid fk intake_links, nullable), client_name_enc (bytea), client_email_enc (bytea, nullable), client_phone_enc (bytea, nullable), client_name_lower_hash (text, nullable, indexed), client_email_hash (text, nullable, indexed), client_phone_hash (text, nullable, indexed), contact_method (enum 'email'|'sms'|'both'), ip_address (inet), user_agent (text), status (enum 'open'|'finalized'|'expired'|'abandoned'), upload_token_jti (text, unique), created_at, finalized_at (nullable), expires_at, linked_connect_client_id (uuid fk to existing Connect clients table, nullable), linked_by_user_id (uuid fk users, nullable), linked_at (timestamptz, nullable), auto_delete_at (timestamptz, nullable, indexed), notification_failed (boolean, default false).
- [ ] Create `intake_files` — id (uuid pk), session_id (uuid fk intake_sessions, cascade delete), original_filename (text), stored_path (text), mime_type (text), size_bytes (bigint), sha256 (text), kind (enum 'file'|'scanned_image'), order_index (integer), virus_scan_status (enum 'pending'|'clean'|'infected'|'error'), created_at.
- [ ] Create `intake_pdfs` — id (uuid pk), session_id (uuid fk intake_sessions, cascade delete), stored_path (text), size_bytes (bigint), sha256 (text), page_count (integer), source_file_ids (uuid array), conversion_started_at (timestamptz, nullable, indexed), conversion_status (enum 'pending'|'processing'|'done'|'failed'), error_message (text, nullable), created_at.
- [ ] Create `intake_links` — id (uuid pk), token (text unique, indexed, 22 chars), created_by_user_id (uuid fk users), assigned_staff_id (uuid fk users), expires_at (timestamptz), revoked_at (timestamptz, nullable), use_count (integer, default 0), client_email_enc (bytea, nullable), client_phone_enc (bytea, nullable), note_to_client (text, nullable, server-side length 500), created_at.
- [ ] Create `intake_uploads_in_progress` — mirrors `vault_uploads_in_progress` shape: upload_id (text pk, 32-byte hex), session_id (uuid fk), upload_length (bigint), upload_offset (bigint), metadata_json (jsonb), expires_at (timestamptz, indexed), created_at.
- [ ] Create `intake_notifications_outbox` — id (uuid pk), session_id (uuid fk, nullable), channel (enum 'email'|'sms'|'in_app'), recipient_hash (text), template_id (text), payload (jsonb), status (enum 'pending'|'sending'|'sent'|'failed'|'deferred'), attempts (integer, default 0), next_attempt_at (timestamptz, indexed), last_error (text, nullable), created_at, sent_at (nullable).
- [ ] Create `intake_key_rotations` — id (uuid pk), started_at, completed_at (nullable), status (enum 'running'|'paused'|'completed'|'failed'), total_sessions, processed_sessions, total_files, processed_files, total_pdfs, processed_pdfs, last_processed_session_id (uuid, nullable), error_message (text, nullable), started_by_user_id (uuid fk users), dry_run (boolean, default false).
- [ ] Create `intake_session_archives` — session_id (uuid fk), user_id (uuid fk users), archived_at; pk (session_id, user_id). Mark-as-read tracking either as a column on `intake_sessions` or a similar per-user table — pick one and document it.
- [ ] Indexes: `intake_sessions(staff_id, created_at desc)`, `intake_sessions(status, created_at)`, `intake_sessions(auto_delete_at) WHERE auto_delete_at IS NOT NULL`, `intake_sessions(client_email_hash)`, `intake_sessions(client_phone_hash)`, `intake_sessions(client_name_lower_hash)`, `intake_files(session_id, order_index)`, `intake_pdfs(conversion_status, conversion_started_at) WHERE conversion_status = 'pending'`, `intake_notifications_outbox(status, next_attempt_at) WHERE status IN ('pending','deferred')`.
- [ ] Row-type interfaces in `apps/server/src/repositories/intake.ts` mirroring all the new tables (see `repositories/vaults.ts` lines 6–10 for the style).
- [ ] Zod schemas inline at the top of each new route file in `apps/server/src/routes/intake/` (matches the project convention — no central `src/schemas/intake.ts`).
- [ ] Encryption helper `apps/server/src/services/intakeCrypto.ts` — exports `encryptField(plaintext: string): Buffer`, `decryptField(ct: Buffer): string`, `encryptStream(plain: Readable): Readable`, `decryptStream(ct: Readable): Readable`, `hashForAudit(plaintext: string): string` (HMAC-SHA256 with the intake key as key), `searchHash(plaintext: string): string` (HKDF-SHA256(SESSION_SECRET, 'vibe-connect/intake-search/v1', purpose) — separate root so it survives intake-key rotation). Loads the root key from `CONNECT_INTAKE_ENCRYPTION_KEY` env at module import; throws on missing/malformed key when intake routes are enabled in `NODE_ENV=production`. Reuses `secretboxEncrypt`/`secretboxDecrypt` from `@vibe-connect/crypto` — does not call libsodium directly.
- [ ] `.env.example` updated with `CONNECT_INTAKE_ENCRYPTION_KEY=` plus the generation comment: `# 32-byte libsodium secretbox key (base64). Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))". Required when intake is enabled in production. Distinct from SESSION_SECRET per ADR-028.`
- [ ] Migration up/down verified locally with `yarn db:migrate` and `yarn db:rollback`.

**Acceptance:**
- All new tables created with correct columns, types, FKs, and indexes; `firm_settings` and `users` augmented without regressing any existing Connect query (run `yarn typecheck && yarn lint && yarn test`).
- Existing `firm_settings(id=1)` singleton row survives the ALTER and gets the new columns at their defaults.
- Encrypted columns are `bytea` and round-trip cleanly through `intakeCrypto.encryptField` / `decryptField`.
- `searchHash('foo@example.com')` is deterministic across server restarts.
- Down migration leaves the DB byte-identical to pre-up state (excluding migration ledger).
- Server boots with a clear error if `CONNECT_INTAKE_ENCRYPTION_KEY` is missing and `NODE_ENV=production`.

---

## Sub-phase 28.2 — Staff Settings UI

**Goal:** Each staff configures their intake-card presence; admins manage global order. Fits the existing flat-card layout of `apps/web/src/pages/Account.tsx`.

**Checklist:**
- [ ] Add an `<IntakeCardSettings />` card to `apps/web/src/pages/Account.tsx` as a new section beside the existing `AvatarCard`, `ChangePasswordCard`, `MyDevicesCard`. No new tabs.
- [ ] Toggle: "Show me on the public intake page" → `PATCH /api/users/me/intake-card` writes `users.show_on_intake_card`.
- [ ] Headshot upload: image picker, client-side preview, server-side resize to 400×400 webp via `sharp`, store in the existing user-assets storage path (reuse `services/attachmentStorage.ts`), write `users.intake_card_headshot_url`.
- [ ] Title field: single line, 60 char max, plain text (e.g., "Senior Tax Manager"). Server-side length check authoritative.
- [ ] Bio field: textarea, 280 char max with live counter, plain text only (sanitized server-side).
- [ ] Admin-only page `/app/settings/intake-cards` mounted under the existing `apps/web/src/pages/Admin.tsx` tab list (`Admin.tsx:13-28` pattern): table of all opted-in staff with drag-handle reorder, writes `users.intake_card_order` via a batch endpoint.
- [ ] API: `GET /api/users/me/intake-card`, `PATCH /api/users/me/intake-card` (self), `GET /api/admin/intake-cards`, `POST /api/admin/intake-cards/reorder` (admin only, body `Array<{ user_id, order }>`).
- [ ] RBAC: staff can edit own toggle/bio/headshot/title (existing `requireAuth` + self-id check); only Admin role can override others or change global order (use existing role gate from `apps/server/src/routes/admin.ts`).
- [ ] Audit log: `auditRepo.write({ action: 'intake.card.updated', ... })` and `action: 'intake.card.order_changed'` events.
- [ ] Empty-state validation surfaced to admin: warning banner on `/app/intake` if zero staff opted in (computed via a small `GET /api/admin/intake/status` endpoint).

**Acceptance:**
- Staff can opt in/out from `/app/account` and changes appear on `/intake` within one cache TTL (default 60s).
- Admin can drag-reorder and overrides persist across browser refreshes.
- Headshot upload rejects non-image MIME, files > 5MB, and produces a 400×400 webp regardless of input dimensions.
- Bio + title length limits enforced server-side (UI counter is advisory).
- Audit events fire on every change and are visible via the existing audit view.

---

## Sub-phase 28.3 — Public Intake Landing (`/intake`)

**Goal:** Anonymous client lands on a grid of staff cards. Implemented in the new `apps/intake/` SPA.

**Checklist:**
- [ ] New workspace `apps/intake/` — Vite + React 18 + Tailwind + TypeScript, `package.json` name `@vibe-connect/intake`, scripts `dev`/`build`/`typecheck`/`test` matching the other apps.
- [ ] `<base href="__BASE_HREF__/">` placeholder so nginx's `sub_filter` substitutes the BASE_PATH at request time (matches `apps/web` and `apps/portal`).
- [ ] `BrowserRouter basename={window.__VIBE_BOOT__.basePath ?? '/'}` so `/intake` becomes `/connect/intake` in multi-app mode automatically.
- [ ] Route `/intake` in the SPA renders the staff card grid. No Connect chrome, no auth.
- [ ] `GET /api/public/intake/staff` — returns `[{id, display_name, title, bio, headshot_url, order}]` filtered to `users.show_on_intake_card=true`, sorted by `intake_card_order` nulls last then `display_name`. Cached server-side for 60s (in-memory Map with TTL — no Redis).
- [ ] Card grid: 1 col mobile / 2 col tablet / 3 col desktop, generous spacing.
- [ ] Each card: circular headshot (or initials fallback), name, title, 2-line bio truncation, "Select" CTA navigating to `/intake/:staffId`.
- [ ] Firm branding header (logo, firm name) read from `window.__VIBE_BOOT__` (already emitted by `apps/server/src/routes/bootstrap.ts`).
- [ ] Footer disclosure: *"Files uploaded here are encrypted at rest. By proceeding you confirm the documents are yours to share. This page does not create an account."* (Exact wording from ADR-028 user-facing disclosure.)
- [ ] Empty state when no staff opted in: friendly *"Intake is not yet configured. Please contact [firm support email]."* — pulled from `firm_settings.firm_name` and an existing support-email setting.
- [ ] Meta tags: `noindex, nofollow`, no Open Graph.
- [ ] CSP: add a `location ~ ^/intake(/|$)` block in `infra/docker/nginx.conf.template` with a scoped `add_header Content-Security-Policy` (no inline scripts; allow inline svg for headshots). Mirror the multi-app mode prefix automatically via the template's existing BASE_PATH wiring. The Express layer keeps `contentSecurityPolicy: false` (per the comment at `apps/server/src/app.ts:70`).
- [ ] Add `/intake`, `/intake/t/`, and `/api/public/intake/` to the public-route regex in `nginx.conf.template` so these proxy to the app and return the SPA shell (or JSON for API).
- [ ] Accessibility: keyboard nav across cards, aria labels, manual axe-DevTools pass (no axe-core dependency required).
- [ ] Page load p95 < 800ms with 20 cards.

**Acceptance:**
- Anonymous visitor sees only opted-in staff in correct order.
- API response contains no internal/PII fields (no email, no role, no last_login).
- Card grid responsive at 320px, 768px, 1280px breakpoints.
- Lighthouse accessibility ≥ 95.
- `BASE_PATH=/connect` build serves `/connect/intake` correctly without rebuilding.

---

## Sub-phase 28.4 — Anonymous Client Intake Form

**Goal:** After selecting a staff member, client provides name + at least one contact channel.

**Checklist:**
- [ ] Route `/intake/:staffId` in `apps/intake` displays the selected staff card at top with "Send files to [Name]".
- [ ] Form fields: client name (required, max 120 char), email (optional, RFC 5322 validation), phone (optional, libphonenumber E.164 normalization).
- [ ] Inline validation: name required; at least one of email/phone required; both formats validated if provided.
- [ ] Helper text: "We'll use this to confirm receipt — we won't email or call you for anything else."
- [ ] Turnstile widget if `TURNSTILE_SITE_KEY` is configured; skipped gracefully if not.
- [ ] Server route `POST /api/public/intake/sessions` in `apps/server/src/routes/intake/public.ts` (mounted public, no auth). Body `{staffId, name, email?, phone?, turnstileToken?}`; creates `intake_sessions` row with PII encrypted via `intakeCrypto.encryptField`, populates `client_*_hash` columns via `intakeCrypto.searchHash`, returns `{sessionId, uploadToken, expiresAt}`.
- [ ] Upload token: signed JWT, 4h TTL, claims `sid` (session id), `staff` (staff id), `jti` (matches `upload_token_jti` column). Signing key derived via HKDF-SHA256(`SESSION_SECRET`, 'vibe-connect/intake-upload-token/v1', 'sign') — *not* the intake content key. Rotating the intake content key does not invalidate in-flight upload tokens.
- [ ] Rate limit: 5 session creations per IP per 15 min using an in-memory sliding window (mirror the existing limiter in `apps/server/src/routes/portal.ts`; no Redis). Return 429 with `Retry-After`.
- [ ] On 200, navigate to `/intake/:staffId/upload?s={sessionId}` with token in `sessionStorage`.
- [ ] All client-provided strings encrypted at rest via `intakeCrypto.encryptField`; search-hash columns populated alongside.
- [ ] Audit log: `auditRepo.write({ action: 'intake.session.created', actorUserId: null, targetType: 'intake_session', targetId: sessionId, details: { hashed_ip: hashForAudit(ip), ua_hash: hashForAudit(ua), staff_id, contact_method, turnstile_passed }, ipAddress: req.ip })`.

**Acceptance:**
- Submitting with neither email nor phone returns 400 with clear message.
- Invalid email or phone format rejected.
- Turnstile failure blocks creation when configured.
- Rate limit returns 429 after 5 attempts and recovers after window.
- Session row contains only encrypted PII (verified by direct DB query).
- Upload token cannot be reused after `finalized_at` is set.
- Audit row contains no plaintext PII.

---

## Sub-phase 28.5 — Chunked Multi-File Upload Pipeline

**Goal:** Robust resumable upload for desktop and mobile with server-side encryption at rest. Reuses Connect's in-tree tus 1.0.0 implementation.

**Checklist:**
- [ ] Extract the tus protocol layer from `apps/server/src/services/tusServer.ts` into `apps/server/src/services/tusProtocol.ts` — pure protocol handling parameterized by a context object `{ authCheck, repo, finalize, maxSize }`. Existing `tusServer.ts` becomes a thin wrapper that injects vault context. Verify the vault upload path still passes its tests.
- [ ] New `apps/server/src/services/intakeTusServer.ts` injects intake context: auth = validate upload-token JWT from `Authorization: Bearer`, ensure session `status='open'`, `jti` matches `upload_token_jti`; repo = `intake_uploads_in_progress`; finalize = `intakeUploadService.onFinish`; maxSize = `firm_settings.intake_max_file_bytes`.
- [ ] Mount at `/api/public/intake/uploads` in `apps/server/src/app.ts` in the public-routes section.
- [ ] Allowed MIME types: `application/pdf`, `image/jpeg`, `image/png`, `image/heic`, `image/webp`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `text/csv`, `text/plain`.
- [ ] Blocked extensions (defense in depth, checked alongside MIME): `.exe`, `.bat`, `.sh`, `.js`, `.html`, `.zip`, `.rar`, `.7z`, `.tar`, `.gz`.
- [ ] Per-file size cap: `firm_settings.intake_max_file_bytes` (default 50MB, admin-configurable up to 250MB).
- [ ] Per-session aggregate cap: `firm_settings.intake_max_session_bytes` (default 250MB, admin-configurable up to 1GB).
- [ ] `apps/server/src/services/intakeUploadService.ts:onFinish` — stream the assembled tus blob through `intakeCrypto.encryptStream` to encrypted file on disk via `services/attachmentStorage.ts:put`; compute plaintext sha256 incrementally during the streaming encrypt.
- [ ] After full upload: ClamAV scan via `services/clamav.ts:scanBuffer` (loaded back through the encrypted-storage adapter — same pattern as vault). On `infected`, delete encrypted file via `attachmentStorage.delete`, set `intake_files.virus_scan_status='infected'`, `auditRepo.write({ action: 'intake.file.rejected_infected', ... })`, return 422.
- [ ] Write `intake_files` row with `kind='file'`, original filename sanitized to remove path separators and null bytes.
- [ ] Client UI in `apps/intake/src/upload/`: drag-drop zone + file picker, per-file progress bars, retry button on chunk failure, remove-before-finalize control. Adapt `tusUploadCiphertext()` logic from `apps/portal/src/lib/vaultClient.ts` for anonymous upload tokens — copy into `apps/intake/src/lib/intakeUploadClient.ts`. Note: vault encrypts client-side first; intake sends plaintext bytes over TLS and the server encrypts at rest (per ADR-028).
- [ ] Mobile: file picker with `multiple` attribute on desktop browsers; mobile shows "Scan a document" button prominently (links to 28.6) alongside file picker.
- [ ] Running total displayed: "3 files · 12.4 MB / 250 MB".
- [ ] `POST /api/public/intake/sessions/:id/finalize` — validates token, sets `intake_sessions.status='finalized'` and `finalized_at`, inserts an `intake_pdfs` row with `conversion_status='pending'` (picked up by the 28.9 ticker), inserts `intake_notifications_outbox` rows for client (28.10) and staff (28.12), returns success-page URL.
- [ ] Success page in `apps/intake`: "Thanks, [Name]. [Firm] received your [N] file(s). We've sent a confirmation to [contact]."

**Acceptance:**
- Killing connection mid-upload and reopening resumes from last completed chunk (tus protocol).
- Encrypted file on disk fails to open without the intake key (manual verification with a wrong key).
- EICAR test file is detected, deleted, and audit-logged with `action='intake.file.rejected_infected'`.
- Disallowed extensions rejected at API level even with spoofed MIME.
- Aggregate cap enforced; 251st MB rejected on a 250MB-cap session.
- Finalize is idempotent and rejects after session is already finalized.
- Vault tus path still green (regression check).

---

## Sub-phase 28.6 — PWA Scanner: Camera Capture

**Goal:** Native-feeling document camera in `apps/intake`, with graceful fallback. No precedent in Connect — built from scratch.

**Checklist:**
- [ ] "Scan a document" button on `/intake/:staffId/upload`; prominent on mobile viewports, secondary on desktop.
- [ ] Feature detection on click: `navigator.mediaDevices?.getUserMedia` + `enumerateDevices` shows a `videoinput` with rear-camera label.
- [ ] If supported: open full-screen camera modal with live video preview, capture button, cancel, flashlight toggle (where `MediaStreamTrack.applyConstraints({torch: true})` is available).
- [ ] If unsupported: fall back to `<input type="file" accept="image/*" capture="environment" multiple>` and skip 28.7's edge detection (image goes straight to upload pipeline).
- [ ] `getUserMedia` constraints: `{video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}}}`.
- [ ] Captured frame: draw video to off-screen canvas at native resolution → `canvas.toBlob('image/jpeg', 0.9)`.
- [ ] Permission denial UX: full-screen message with platform-specific instructions and "Use file picker instead" button.
- [ ] Stop all video tracks immediately after capture or modal close (battery/heat).
- [ ] Camera modal locks orientation to portrait via CSS where possible.
- [ ] Document iOS quirks in code comments: `getUserMedia` in PWA mode requires iOS 16.4+; in-app browsers (Instagram, Facebook) often block `getUserMedia` entirely.

**Acceptance:**
- Modern Android Chrome PWA: full flow works including torch.
- iOS 16.4+ PWA (added to home screen): full flow works.
- iOS Safari (not PWA): full flow works.
- In-app browser: falls back to file picker without error.
- Permission denial recovers cleanly to file picker fallback.

---

## Sub-phase 28.7 — PWA Scanner: Edge Detection & Perspective Correction

**Goal:** Auto-crop and deskew captured page; allow manual adjustment.

**Checklist:**
- [ ] Add `jscanify` (pinned version) to `apps/intake/package.json`; dynamic import, loaded only when scanner first opens.
- [ ] After capture, pass blob to jscanify corner detection.
- [ ] Render overlay quad on top of captured still; corners are draggable touch targets ≥ 44px.
- [ ] User confirms or adjusts; on confirm, run perspective transform via jscanify.
- [ ] Post-transform enhancement: toggle between "Color" (original), "Grayscale" (default), "B&W" (adaptive threshold).
- [ ] Output: `canvas.toBlob('image/jpeg', 0.85)`, max 2000px on long edge (resize if needed).
- [ ] "Retake" button discards transform result and re-opens camera.
- [ ] If corner detection fails or confidence is low: show default rectangle covering most of frame, user adjusts manually.
- [ ] Performance budgets: detection ≤ 800ms p95 on mid-tier 2022 Android; transform ≤ 400ms.
- [ ] Scanner chunk total bundle ≤ 200KB gzipped (verify with `yarn workspace @vibe-connect/intake build` + bundle analyzer).

**Acceptance:**
- Standard letter-size page in good lighting: auto-crop is reasonable without user adjustment in 8/10 manual test shots.
- Manual corner drag works on touch (verified on iPhone and Android).
- Grayscale output is visibly cleaner than raw photo (visual QA).
- Bundle budget met.
- Failed detection path tested by capturing a blank wall.

---

## Sub-phase 28.8 — PWA Scanner: Multi-Page Batch & Review

**Goal:** Capture multiple pages, reorder, retake, then submit as an ordered set.

**Checklist:**
- [ ] After each page processed in 28.7, append to in-memory page list with thumbnail (data URL).
- [ ] After confirm: prompt "Add another page" or "Done".
- [ ] Review screen: vertical list of thumbnails with page numbers, drag-to-reorder, "Retake page" replaces a single page, "Delete page" with confirmation.
- [ ] Persistent page counter: "Page 3 of 5" visible during capture.
- [ ] On "Submit pages": each page POSTed as a separate `intake_files` row with `kind='scanned_image'` and `order_index` matching review order, then session finalized via 28.5.
- [ ] Scanned pages count toward session aggregate size cap (same enforcement).
- [ ] IndexedDB persistence: page list survives accidental in-tab navigation; cleared on submit or explicit cancel.
- [ ] Cancel-with-pages confirmation modal: "Discard [N] pages?"
- [ ] Memory budget: 20 captured pages held simultaneously without crashing a 4GB-RAM Android device.

**Acceptance:**
- 10-page capture flow works end-to-end on mid-tier Android and iPhone 12 without OOM.
- Reorder, retake, delete all behave correctly and reflected in upload `order_index`.
- IndexedDB recovery: tab refresh during review restores page list.
- Cancel discards all in-progress pages and clears IndexedDB.

---

## Sub-phase 28.9 — Server-Side Image-Set → PDF Conversion (in-process ticker)

**Goal:** Combine session's scanned images into one PDF with a generated cover page; pass through non-image files untouched. Implemented as a `setInterval` ticker — *not* BullMQ — because Connect does not run Redis.

**Checklist:**
- [ ] New service `apps/server/src/services/intakePdfTicker.ts` exporting `startIntakePdfConversionTicker()` and `stopIntakePdfConversionTicker()`. Polls every 5 seconds.
- [ ] Atomic claim: `UPDATE intake_pdfs SET conversion_status='processing', conversion_started_at=now() WHERE id IN (SELECT id FROM intake_pdfs WHERE conversion_status='pending' AND conversion_started_at IS NULL ORDER BY created_at LIMIT $concurrency FOR UPDATE SKIP LOCKED) RETURNING *`. Mirror `apps/server/src/services/scheduledMessages.ts:95-100`.
- [ ] Concurrency: `firm_settings.intake_conversion_concurrency` (default 2), honored as a per-tick batch size.
- [ ] Worker body: load session + all `intake_files` rows, separate scanned images (ordered by `order_index`) from uploaded files.
- [ ] Decrypt each scanned image (streaming via `intakeCrypto.decryptStream`) to temp dir at `/tmp/intake-conversion-${jobId}/`; verify sha256.
- [ ] Generate cover page (PDF page 1) via `pdf-lib` with firm branding header (logo + firm name from `firm_settings`) and these fields:
  - "Document Intake Cover Sheet" title
  - From: client name (decrypted via `intakeCrypto.decryptField`)
  - Contact: email and/or phone (decrypted, whichever provided)
  - Submitted: `finalized_at` in firm timezone
  - Received by: staff `display_name` + `intake_card_title`
  - Source: "Public intake page" or "Direct link from [staff name]"
  - Scanned pages included in this PDF: numbered list with original filename and size
  - Additional files attached to this submission (not in this PDF): list of uploaded non-image files with names and sizes
  - Submission reference: short hash of session_id (first 8 chars of sha256(session_id))
- [ ] Cover page generation can be disabled per firm via `firm_settings.intake_include_cover_page=false` (default true).
- [ ] If multiple scanned images: append after cover page, one image per page, fit-to-page A4 portrait, preserve aspect ratio, no margins.
- [ ] If single scanned image: cover page + single image page.
- [ ] If zero scanned images (only uploaded files): generate cover-page-only PDF documenting the submission, save as `intake_pdfs` row with `page_count=1`.
- [ ] Resulting PDF encrypted via `intakeCrypto.encryptStream` to `intake_pdfs.stored_path` (through `attachmentStorage`).
- [ ] Update `intake_pdfs` row: `size_bytes`, `sha256`, `page_count`, `conversion_status='done'`.
- [ ] Non-image uploaded files: never touched, remain as-is in `intake_files`.
- [ ] Temp files deleted in a `finally` block (do not assume OS cleanup).
- [ ] Retry policy: on failure, decrement attempts down from 3, set `conversion_status='pending'` and `conversion_started_at=NULL` with `next_attempt_at` advanced by exponential backoff (1m, 5m, 15m). On permanent failure (3 attempts exhausted) set `conversion_status='failed'`, capture `error_message`, audit event `intake.pdf.conversion_failed`, enqueue `intake_notifications_outbox` row for firm admins (28.12 admin escalation).
- [ ] Structured log events at every state transition: `logger.info('intake.pdf_conversion_started', { jobId, sessionId })`, `logger.info('intake.pdf_conversion_duration_ms', { jobId, ms, pages })`, `logger.warn('intake.pdf_conversion_retry', { jobId, attempt })`, `logger.error('intake.pdf_conversion_failed', { jobId, error })`. A future Prometheus phase scrapes these from logs or wires `prom-client` directly.
- [ ] Start/stop hooks added to `apps/server/src/index.ts` alongside the seven existing tickers (boot at lines 45-61, stop at 138-144).

**Acceptance:**
- 5-image session → single PDF with cover page + 5 image pages = 6 total pages.
- Single-image session → cover page + 1 image page = 2 total pages.
- Zero-image session (uploaded PDFs only) → cover-page-only PDF documenting the submission.
- Mixed session (3 scanned + 2 uploaded PDFs) → cover-page-led PDF with 4 total pages (cover + 3 scans) plus the two original PDFs alongside.
- Cover page lists uploaded files correctly even when none are scanned.
- Disabling `intake_include_cover_page` skips cover generation and produces images-only PDF.
- 20 concurrent sessions on a 16GB NucBox: no OOM, queue drains within 5 min.
- Permanent failure path: status set, error captured, admin notified via 28.12.
- Ticker survives `SIGTERM` via the existing graceful-shutdown drain.

---

## Sub-phase 28.10 — Client Completion Notification

**Goal:** Confirm receipt to the client via every channel they provided.

**Checklist:**
- [ ] Notification rows enqueued by 28.5 finalize into `intake_notifications_outbox` with `channel ∈ {'email', 'sms'}` and `status='pending'`.
- [ ] New service `apps/server/src/services/intakeClientNotifyTicker.ts` polls every 10 seconds: `UPDATE intake_notifications_outbox SET status='sending' WHERE id IN (SELECT id FROM intake_notifications_outbox WHERE status='pending' AND next_attempt_at <= now() AND channel IN ('email','sms') ORDER BY next_attempt_at LIMIT N FOR UPDATE SKIP LOCKED) RETURNING *`.
- [ ] Channel selection: enqueued for email AND SMS if both were provided; otherwise only the provided channel. Behavior controlled by `firm_settings.intake_send_to_both_channels` (default true).
- [ ] Email template: branded with firm logo + name; subject "We received your files"; body lists file count and total size; includes "If this wasn't you, please contact [firm support]"; sent via `getEmailProvider()` from `apps/server/src/bridges/email/index.ts`.
- [ ] SMS template via `getSmsProvider()` from `apps/server/src/bridges/sms/index.ts`: "Hi [Name], [Firm] received your [N] file(s). Reply STOP to opt out."
- [ ] Hard rule: never include a download link, session id, or file metadata in client-facing notification.
- [ ] Audit log: `auditRepo.write({ action: 'intake.client_notification.sent', ... })` with channel, hashed recipient, template_id — one event per channel sent.
- [ ] On send failure: increment `attempts`, set `next_attempt_at` with exponential backoff. After 3 attempts set `status='failed'`, set `intake_sessions.notification_failed=true`, surface in 28.11 staff view (per-channel detail preserved in audit log).
- [ ] Quiet hours: respect existing SMS quiet-hours config (skip SMS 9pm–8am firm timezone; defer to next-day 8am via `status='deferred'` + `next_attempt_at` rather than dropping; email always sent immediately).
- [ ] Bounce/STOP handling: existing bridge handlers; no additional work here.
- [ ] Start/stop hooks added to `apps/server/src/index.ts`.

**Acceptance:**
- Email-only client receives email.
- Phone-only client receives SMS.
- Both-provided client receives both.
- SMS during quiet hours is `deferred` (not dropped) and arrives at 8am firm time.
- Failed notifications retry and ultimately surface to staff with per-channel detail.
- Audit log contains only hashed recipient, never plaintext.

---

## Sub-phase 28.11 — Staff Received Uploads View

**Goal:** Staff sees inbound sessions; admins see all. Lives in `apps/web` (staff SPA).

**Checklist:**
- [ ] New section in `apps/web`: `/app/intake` (list view of `intake_sessions`) under the existing Admin tabs pattern (`apps/web/src/pages/Admin.tsx:13-28`).
- [ ] Columns: client name (decrypted on view), contact, staff recipient, file count, total size, received at, status (pending conversion / ready / failed / notification failed).
- [ ] Filters: by staff (own/all if admin), date range, status.
- [ ] Server-side pagination, 50 per page, sortable by `received_at` and `total_size`.
- [ ] Row click → detail drawer: client info (decrypted on view, audit logged `intake.session.decrypted_on_view`), file list (each downloadable, PDFs and images preview inline), assembled PDF prominently displayed if present, audit timeline for this session (filtered view of `audit_log` where `target_id = session_id`).
- [ ] Bulk select → "Download as zip" — streaming zip including assembled PDFs and original files, decrypted on the fly through `intakeCrypto.decryptStream`.
- [ ] Search by client name / email / phone: server queries `intake_sessions` where `client_*_hash = searchHash(query)`. Rate-limited 30 searches/min per user (in-memory limiter, same shape as portal).
- [ ] RBAC: staff sees only `staff_id = req.session.userId` sessions; admin sees all and can filter to any staff.
- [ ] Per-staff archive via `intake_session_archives` table — non-destructive, toggles row out of default view.
- [ ] Mark-as-read state per staff (decision: extend `intake_session_archives` with a `read_at` column, or add a sibling table — pick during implementation and document).
- [ ] **Post-hoc client linking:** "Link to client" action on session detail drawer opens a search modal against the existing Connect client directory (reuse the conversations clients search API); on selection, write `intake_sessions.linked_connect_client_id`, `linked_by_user_id`, `linked_at`; `auditRepo.write({ action: 'intake.session.client_linked', ... })`.
- [ ] **Unlink action:** clears the three link columns; audit log `intake.session.client_unlinked`.
- [ ] When a session has a linked client, the session detail drawer shows the linked client name with a deep link to the Connect client record; list view shows a small "Linked" badge.
- [ ] Linking is soft only: no files are moved, no Connect client record is mutated, no Vault entries are created.
- [ ] API: `POST /api/intake/sessions/:id/link-client {clientId}`, `DELETE /api/intake/sessions/:id/link-client`.
- [ ] RBAC: staff can link own sessions; admin can link any.

**Acceptance:**
- Staff cannot see other staff's sessions (verified via API call with different user session).
- File previews work for PDF and image types without forcing download.
- Bulk zip streams without loading all files into memory (verify with 1GB session).
- Search returns correct results within p95 < 1s on 10k sessions.
- Decryption-on-view audit events fire and are visible in 28.17.
- Linking a session to a Connect client persists, displays correctly in both list and detail views, and emits audit events; unlinking is reversible without data loss.

---

## Sub-phase 28.12 — Staff Notifications

**Goal:** Staff is alerted to new sessions immediately or via digest.

**Checklist:**
- [ ] On 28.5 finalize, insert a `intake_notifications_outbox` row with `channel='email'` and `channel='in_app'` for the assigned staff.
- [ ] New service `apps/server/src/services/intakeStaffNotifyTicker.ts` polls the outbox for `channel IN ('email', 'in_app')`.
- [ ] Email template: "New intake from [client name] — [N] files", deep link to `/app/intake?session=:sessionId`; sent via `getEmailProvider()`.
- [ ] In-app notice piggybacks on the existing realtime fanout (`apps/server/src/realtime/pgFanout.ts`): publish `{ type: 'intake.session.received', userId, sessionId, ... }` on a new event type. The staff SPA's existing realtime listener (`apps/web/src/state/notifications.ts`) gets a small extension to surface intake events in the tab badge.
- [ ] Per-staff preference UI in `apps/web/src/pages/Account.tsx` `<IntakeCardSettings />`: "Email me for every intake" (default) | "Daily digest at [time]" | "In-app only".
- [ ] Digest mode: a separate path inside the same ticker fires when `now()` hour in firm timezone matches `firm_settings.intake_digest_hour_local`. Aggregates per staff; skips empty digests.
- [ ] Admin escalation: on `intake_pdfs.conversion_status='failed'` (28.9), enqueue a notification to all Admin role users regardless of their preferences. Template clearly distinct from a normal received-intake email.
- [ ] Audit log: `auditRepo.write({ action: 'intake.staff_notification.sent', ... })` per channel per recipient.

**Acceptance:**
- Real-time email + in-app notice within 10s of finalize under normal queue load.
- Digest mode batches correctly and skips empty digests.
- Admin escalation fires on conversion failure and is distinct in template.
- Preference change takes effect on next-finalized session immediately.

---

## Sub-phase 28.13 — Send-a-Link Generator

**Goal:** Staff creates a tokenized URL bound to a specific client contact.

**Checklist:**
- [ ] New page `/app/intake/links` in `apps/web` and "Send intake link" quick action from staff dashboard.
- [ ] Form fields: client email OR phone (one required, both allowed), expiration preset (24h / 7d / 30d / custom datetime), optional note to client (500 char max, plain text), assigned staff (defaults to self; admin can assign to any staff).
- [ ] Token generation: `crypto.randomBytes(16).toString('base64url')` (22 chars), stored in `intake_links.token` with unique constraint.
- [ ] On create: send link via chosen contact channel(s) — both if both provided. Reuse `getEmailProvider()` / `getSmsProvider()`.
- [ ] Message template (email): "[Staff Name] at [Firm] is requesting documents from you. Please upload here: [link]. This link expires [date]. [If note provided: 'Note: {note}']"
- [ ] Message template (SMS): "[Firm]: [Staff Name] requested documents. Upload: [link] (expires [date])"
- [ ] List view at `/app/intake/links`: active links with countdown to expiry, sent-to contact, assigned staff, use count, revoke button.
- [ ] Revoke action: set `revoked_at=now()`; tokenized landing returns 410 immediately afterward.
- [ ] No prefill of client name/contact on the upload form; client confirms themselves.
- [ ] Resend action: re-send the same link to the same contact (audit logged separately).
- [ ] Audit log: `intake.link.created`, `intake.link.sent`, `intake.link.revoked`, `intake.link.resent`.

**Acceptance:**
- Token URLs are unguessable (≥ 128 bits entropy verified).
- Link visit after `expires_at` returns 410.
- Revoked link returns 410 immediately even before expiry.
- Email and SMS sends confirmed via existing transports.
- List view sorted by `created_at desc` by default, with active/expired/revoked filter.

---

## Sub-phase 28.14 — Tokenized Intake Flow

**Goal:** Client landing page for tokenized URLs, bypassing the staff-card grid.

**Checklist:**
- [ ] Public route `/intake/t/:token` in `apps/intake`.
- [ ] Token resolution: `GET /api/public/intake/links/:token` — invalid → 404 generic; expired → 410 with "This link has expired. Please contact [firm support]."; revoked → 410 same message.
- [ ] On valid: page shows assigned staff card at top, optional note from staff if `note_to_client` present, then identical intake form as 28.4 below.
- [ ] Session created with `source='staff_link'` and `token_id` set.
- [ ] All subsequent flow (upload, scan, finalize, notifications, conversion) identical to public path.
- [ ] `intake_links.use_count` incremented on each successful finalize.
- [ ] Rate limit per token: 10 finalizations per hour (in-memory limiter; defense against link sharing/abuse).
- [ ] Audit log: `intake.token.validated`, `intake.token.rejected` (with reason), session-creation audit linked via `token_id`.
- [ ] Friendly 410 page is unbranded enough to avoid leaking firm identity to attackers probing tokens.

**Acceptance:**
- Valid token loads correct staff context and note.
- Expired/revoked/unknown tokens fail closed with appropriate status.
- Session correctly links to token in DB.
- Notifications and conversion behave identically to public path.
- Rate limit enforced and recovers after window.

---

## Sub-phase 28.15 — Retention Policy & Auto-Delete

**Goal:** Firm admin can configure automatic deletion of intake sessions after a configurable number of days.

**Checklist:**
- [ ] Admin settings page `/app/settings/intake` in `apps/web` (admin role only).
- [ ] Settings UI fields backed by `firm_settings`:
  - "Enable auto-delete" toggle → `intake_auto_delete_enabled`
  - "Delete sessions older than [N] days" numeric input → `intake_auto_delete_after_days` (min 30, max 3650, default 365)
  - "Send to both email and SMS when both provided" toggle → `intake_send_to_both_channels`
  - "Include cover page on assembled PDFs" toggle → `intake_include_cover_page`
  - Other firm-level intake knobs (size caps, conversion concurrency, digest hour, maintenance mode)
- [ ] API: `GET /api/admin/intake/settings`, `PATCH /api/admin/intake/settings`.
- [ ] On session finalize (28.5), if `firm_settings.intake_auto_delete_enabled=true`, set `intake_sessions.auto_delete_at = finalized_at + intake_auto_delete_after_days`.
- [ ] Toggling auto-delete on retroactively: one-shot backfill that sets `auto_delete_at` on existing finalized sessions where it's null; only fills forward (`max(now() + 7d, finalized_at + N days)`) so already-overdue sessions get a 7-day grace before purge.
- [ ] New service `apps/server/src/services/intakeAutoPurgeTicker.ts` runs hourly:
  - Selects `intake_sessions WHERE auto_delete_at <= now() AND status='finalized'`.
  - For each: `auditRepo.write({ action: 'intake.session.auto_purged', targetId: sessionId, details: { ... } })` BEFORE deletion (the audit row survives because it lives in `audit_log` and has no FK back to `intake_sessions`).
  - Then delete encrypted file blobs via `attachmentStorage.delete`, delete `intake_pdfs` blob, delete `intake_files` rows, delete `intake_sessions` row (cascade handles dependent tables).
- [ ] Hard rule: audit log entries are never auto-purged by this job. Verified by construction since they live in a different table with no FK.
- [ ] Admin pre-purge visibility: list view in 28.11 surfaces an "Expires" column when `auto_delete_at` is set; sessions within 7 days of purge show a warning indicator.
- [ ] Disabling auto-delete clears `auto_delete_at` on all existing sessions (default behavior — "off means off").
- [ ] Per-session admin override: "Keep this session indefinitely" action on session detail (admin only) sets `auto_delete_at=NULL` regardless of firm setting; reverse action also available. Audit `intake.session.retention_overridden`.
- [ ] Audit events: `intake.settings.updated`, `intake.session.auto_purged`, `intake.session.retention_overridden`.
- [ ] Start/stop hooks added to `apps/server/src/index.ts`.

**Acceptance:**
- Enabling auto-delete with 30-day setting causes a 31-day-old session to be purged on the next hourly run.
- Audit log entries persist after their session is purged.
- Files on disk are actually removed (verified via `ls` on the upload volume).
- Disabling auto-delete clears existing `auto_delete_at` values.
- Per-session override survives firm setting changes.
- Retroactive enable does not immediately purge anything; backfill respects 7-day grace.

---

## Sub-phase 28.16 — Intake Key Rotation (admin HTTP routes)

**Goal:** Ship admin tooling to rotate `CONNECT_INTAKE_ENCRYPTION_KEY` without downtime or data loss. **Implemented as authenticated admin HTTP routes — Connect has no CLI binary.**

**Checklist:**
- [ ] New routes in `apps/server/src/routes/admin/intake.ts` (admin role only):
  - `POST /admin/intake/rotate-key/dry-run` — body `{ oldKey?, newKey? }` (keys can also be supplied via env vars `CONNECT_INTAKE_ENCRYPTION_KEY` (current) + `CONNECT_INTAKE_ENCRYPTION_KEY_NEW`); validates both keys decrypt-test on one row each; counts target rows; estimates duration; returns the proposed `jobId` without mutating.
  - `POST /admin/intake/rotate-key` — body `{ batchSize?: number }`; starts the rotation. Refuses to start unless `firm_settings.intake_maintenance_mode=true`. Returns `{ jobId }` immediately; work proceeds in-process.
  - `GET /admin/intake/rotate-key/:jobId` — returns the row from `intake_key_rotations`.
  - `POST /admin/intake/rotate-key/:jobId/resume` — re-enters a paused/failed job at `last_processed_session_id`.
  - `POST /admin/intake/maintenance` — body `{ enabled: boolean, message?: string }`; flips `firm_settings.intake_maintenance_mode`. While true, `/api/public/intake/sessions` and all upload routes return 503 with the configured message.
- [ ] New service `apps/server/src/services/intakeKeyRotation.ts`:
  - Iterates in batches (default 100, body-configurable). For each session: decrypt PII columns (`client_name_enc`, `client_email_enc`, `client_phone_enc`) with old key and re-encrypt with new key; for each `intake_files` row, stream-decrypt and stream-re-encrypt the file on disk to a temp path, then atomically rename; same for `intake_pdfs`; same for `intake_links` encrypted columns.
  - Progress reporting: structured log every 10 sessions (`logger.info('intake.key_rotation.progress', { jobId, processed, total })`); persists progress to `intake_key_rotations.processed_*` columns every batch.
  - SIGTERM/SIGINT-aware via the existing shutdown hook (`apps/server/src/index.ts:127-212`) — registers a `stopIntakeKeyRotation()` that flips status to `paused` and exits cleanly.
  - On any per-row failure: log details, set `intake_key_rotations.status='failed'`, capture `error_message`, do not advance past `last_processed_session_id`. Operator investigates and re-runs via `/resume`.
  - Verification pass after main loop: random sample of 1% of re-encrypted rows, decrypt-test with new key, confirm sha256 unchanged on file content.
- [ ] Operator workflow (documented in `docs/ops/INTAKE.md`):
  1. Generate new 32-byte key.
  2. Set `CONNECT_INTAKE_ENCRYPTION_KEY_NEW` env var alongside existing `CONNECT_INTAKE_ENCRYPTION_KEY`; restart server.
  3. Enable maintenance mode via `POST /admin/intake/maintenance {enabled:true}`.
  4. `POST /admin/intake/rotate-key/dry-run` and review counts.
  5. `POST /admin/intake/rotate-key` and poll status via `GET /admin/intake/rotate-key/:jobId`.
  6. On success: swap env vars (new key becomes `CONNECT_INTAKE_ENCRYPTION_KEY`, old removed), restart server.
  7. `POST /admin/intake/maintenance {enabled:false}` to re-open intake.
- [ ] Dry-run mode validates keys, counts target rows, estimates duration, does not modify any data.
- [ ] Audit log: `intake.key_rotation.started`, `intake.key_rotation.progress` (every 1000 rows), `intake.key_rotation.paused`, `intake.key_rotation.completed`, `intake.key_rotation.failed`, `intake.maintenance_mode.changed`.
- [ ] Hard rule: rotation refuses to start unless `firm_settings.intake_maintenance_mode=true`. Maintenance mode does not affect already-finalized sessions or staff views — only blocks new uploads.

**Acceptance:**
- Dry run accurately reports counts and estimated duration on a 10k-session test corpus.
- Live rotation on the test corpus completes without error and 100% of sampled rows decrypt with the new key.
- SIGTERM mid-rotation pauses cleanly via the shared shutdown hook; resume picks up at `last_processed_session_id`.
- Verification pass catches a deliberately corrupted re-encrypted blob (test by mutating one byte and re-running verify).
- Maintenance mode blocks new uploads with 503 but does not affect already-finalized sessions or staff views.

---

## Sub-phase 28.17 — Audit Log Viewer, PWA Manifest, E2E Tests

**Goal:** Close out with observability, installability, and regression coverage.

**Checklist:**
- [ ] Audit log viewer at `/app/intake/audit` in `apps/web` (Admin only). Implemented as a filtered view over the global `audit_log` table where `action LIKE 'intake.%'` — no new table.
- [ ] Filters: `action` (multi-select), `actor`, `target_id` (session/link), date range.
- [ ] Pagination, default sort `created_at desc`, indexed query path.
- [ ] CSV export streaming for current filter (no in-memory buffering of full result set).
- [ ] Verify every endpoint in 28.0–28.16 emits appropriate audit events; checklist review per route.
- [ ] PWA manifest at `apps/intake/public/manifest.webmanifest`: `name "[Firm] Intake"`, `short_name`, icons, theme color from branding config, `display: standalone`, `start_url: /intake` (or BASE_PATH-prefixed equivalent in multi-app mode — handled by the same `__BASE_HREF__` substitution).
- [ ] No "Add to Home Screen" install prompt (per `docs/QUESTIONS.md` Q5).
- [ ] Playwright E2E suite at `apps/intake/e2e/`: public flow happy path, tokenized flow happy path, scanner flow with mocked camera API, staff received-uploads view, link create + visit + revoke, client linking, retention/auto-purge (with clock manipulation), key rotation smoke (against a small test corpus), audit CSV export. Confirm during 28.17 whether the repo already has Playwright wired anywhere; if not, add it scoped to the intake feature only (do not retrofit other apps).
- [ ] Load test (k6 or similar): 100 concurrent sessions each uploading 10 files of 1MB; verify zero 5xx and PDF conversion ticker drains within 5 min.
- [ ] Operator docs `docs/ops/INTAKE.md`: deployment knobs, env vars, key rotation procedure (links to 28.16 routes), ClamAV sidecar expectations, maintenance mode usage.
- [ ] Firm admin docs `docs/ops/INTAKE_FIRM_ADMIN.md`: staff card configuration, link generation, audit log usage, retention configuration, client linking, settings reference.
- [ ] Update repo README with new feature section linking both docs.
- [ ] Tag release `v1.X.0-intake` and update CHANGELOG.

**Acceptance:**
- Every state-changing API call has a corresponding audit entry (manual review checklist signed off).
- CSV export of 100k events streams without OOM.
- Playwright suite green in CI.
- Load test passes SLOs and PDF conversion p95 < 2 min per session.
- Docs committed and linked from README.

---

## Cross-cutting concerns

- **Encryption key:** Single firm-held libsodium key, env var `CONNECT_INTAKE_ENCRYPTION_KEY` (32 bytes base64). **Independent of `SESSION_SECRET`** per ADR-028 — rotating intake key does not invalidate sessions, provider creds, or ACME state. All encryption/decryption funneled through `apps/server/src/services/intakeCrypto.ts`; no direct libsodium calls in feature code. Key rotation procedure ships in 28.16 as admin HTTP routes (Connect has no CLI binary).
- **Firm-level settings:** All intake configuration lives on the existing singleton `firm_settings(id=1)` table, extended with `intake_*` columns in the 28.1 ALTER. No `firm_settings_intake` table.
- **Audit log:** Reuses the existing `audit_log` table via `auditRepo.write` (`apps/server/src/repositories/audit.ts:14-39`). Actions namespaced `intake.*`. Per-feature `intake_audit_log` table deliberately *not* created — `audit_log` already has the survives-cascade property because `target_id` is a free uuid with no FK back to feature tables.
- **Background work:** All asynchronous intake jobs are in-process `setInterval` tickers with `UPDATE ... RETURNING ... FOR UPDATE SKIP LOCKED` row-claim. Started in `apps/server/src/index.ts` alongside the seven existing tickers (`scheduledMessages`, `destructMessages`, `autoNudge`, `retention`, `vaultRetention`, `backupWatcher`, `tlsAcme`). No Redis, no BullMQ.
- **Storage volume:** Reuses Connect's existing local-or-S3 attachment storage abstraction (`apps/server/src/services/attachmentStorage.ts`). No new volumes required.
- **tus 1.0.0:** Reuses the in-tree implementation from Phase 26 (`apps/server/src/services/tusServer.ts`) via the extracted `services/tusProtocol.ts`. `@tus/server` is *not* added — see the deliberate "no @tus/server dep" comment at the top of `tusServer.ts`.
- **Caddy/nginx ingress:** Nginx is the sole single-app ingress; multi-app mode uses external Caddy via `docker-compose.grouped.yml`. The new public routes (`/intake`, `/intake/t/*`, `/api/public/intake/*`) are added to the public-route regex in `infra/docker/nginx.conf.template`. Multi-app prefix wiring is automatic via the existing `__BASE_HREF__` substitution.
- **ClamAV:** The sidecar is added in 28.0 (the wire-protocol client at `apps/server/src/services/clamav.ts` already exists). No new code beyond reusing `scanBuffer`.
- **Backup:** Intake tables and stored files are included in whatever backup the operator runs against the host Postgres DB + `/var/lib/vibe/connect/uploads`. The existing `/admin/backup-heartbeat` endpoint covers the freshness gate.
- **Telemetry:** Phase 28 emits structured `logger.info('intake.<metric>', { ... })` events at every state transition. No `/metrics` Prometheus endpoint exists in Connect today; a future phase will scrape these from logs or wire `prom-client` directly.
- **i18n:** v1 is English-only. No i18n framework is wired in this repo. The `intake.*` namespace is reserved for a future i18n phase; for v1, strings are hardcoded matching the rest of `apps/web`.
- **Connect client directory dependency:** 28.11's client linking uses the existing Connect clients search API.
- **Crypto invariants:** `packages/crypto` exports remain the only place that touches libsodium. `intakeCrypto.ts` wraps `secretboxEncrypt`/`secretboxDecrypt` from there — does not call libsodium directly.
