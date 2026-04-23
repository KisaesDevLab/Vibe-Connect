# Vibe Connect — Build Plan

*Slots into the Vibe product family alongside Vibe TB and Vibe MyBooks. Internal staff communication first; secure client connectivity via portal + access code, email, and SMS as a deliberate follow-on stack.*

---

## Goal

Replace PinkNotes inside Kurt's own firm as an internal-staff communication tool with universal end-to-end encryption, then extend into a secure client communication channel using a self-serve portal with access-code login, email/SMS bridges, secure document upload, and SSN/EIN step-up verification — preserving the firm's ability to produce records for audit and peer review.

## Non-goals (explicit cuts)

- Subject lines on messages
- "Must Reply" / "No Reply" / "Confidential" flags
- Structured contact-info fields
- Rich text formatting beyond bold/italic/newlines
- Shared calendar, to-do lists
- Channels / streams / topics
- Voice/video, federation, marketplace, omnichannel
- Client-facing mobile apps (clients use portal on web; no install ever)
- Full client accounts with passwords (access-code only)

## Stack

- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS
- **Backend:** Node.js 20 + Express + Knex.js (plain-JS migrations)
- **Database:** PostgreSQL 16
- **Real-time:** Socket.io + Postgres `LISTEN/NOTIFY`
- **File storage:** Local filesystem in appliance volume (S3 driver optional)
- **Desktop app:** Tauri 2.x wrapper (Rust shell + system webview; web bundle unchanged)
- **Mobile:** PWA (staff and clients both use web)
- **Auth:** Local username + password for staff (bcrypt, Argon2id-derived device keys); access codes + SSN/EIN step-up for clients; OIDC deferred
- **Cryptography:** libsodium (`libsodium-wrappers`) in Node + browser; XChaCha20-Poly1305 symmetric, X25519 for key agreement, Argon2id for password-derived keys
- **Client-side search:** FlexSearch over decrypted message cache in encrypted IndexedDB
- **Email:** Postmark (primary); Mailgun or self-hosted Postfix as alternative
- **SMS:** TextLink (primary — BYOD Android + SIM); Twilio 10DLC (alternative for higher-throughput or no-hardware deployments); both behind a single `SmsProvider` interface
- **Deployment:** Docker appliance on GMKtec NucBox M6 + paired Android phone for TextLink

## Trust model

- **All conversations** (staff-to-staff, staff-to-client, internal side-threads): E2EE with firm-held-key model. Server stores ciphertext only.
- **Bridged messages** (email-in, SMS-in): encrypted from the gateway onward — the only plaintext-at-rest window is microseconds between gateway receipt and encryption. UI labels these with a source indicator.
- **Firm recovery key:** managing partner holds a 24-word BIP-39-style recovery phrase enabling decryption for audit, peer review, or subpoena.
- **Staff device keys:** per-device X25519 keypair, private key encrypted with Argon2id-derived key from password, uploaded to server. Revoked on staff termination.
- **Client session keys:** derived from access-code auth + SSN/EIN verification; ephemeral, token-rotating, no persistent client-side storage.

---

## Phase 0 — Prereqs & repo setup

- [ ] Reserve domain (`vibeconnect.app` or similar); reserve GitHub repo under `KisaesDevLab`; reserve Docker Hub namespace
- [ ] Yarn workspaces (match Vibe TB convention)
- [ ] Install `rustup` (stable toolchain) and `@tauri-apps/cli` for the desktop wrapper; verify `cargo tauri --version` on both development machines (Windows + macOS) before starting Phase 13
- [ ] Directory layout: `/apps/web` (staff), `/apps/portal` (client portal), `/apps/desktop` (Tauri 2.x shell with `src-tauri/` Rust subdirectory wrapping the staff web bundle), `/apps/server`, `/packages/shared-types`, `/packages/crypto`, `/infra/docker`
- [ ] TypeScript strict everywhere
- [ ] ESLint + Prettier matching Vibe TB
- [ ] Commit `CLAUDE.md` with project context, stack, phase plan, grep anchors, crypto conventions
- [ ] GitHub Actions: lint + typecheck + test on PR
- [ ] README stub

---

## Phase 1 — Data model & Postgres schema

Schema supports universal E2EE, client portal, step-up verification, and both SMS providers from day one.

- [ ] `users` — id, username, email, password_hash, display_name, avatar_url, is_admin, is_active, created_at, last_seen_at, status
- [ ] `user_keys` — id, user_id, device_id, public_key, encrypted_private_key, key_version, client_platform ('tauri-win' | 'tauri-mac' | 'tauri-linux' | 'pwa' | 'web'), client_version (nullable, semver string), last_heartbeat_at (nullable), created_at, revoked_at (one row per staff device)
- [ ] `firm_keys` — id, public_key, encrypted_recovery_private_key (encrypted with partner's recovery phrase), created_at, rotation_version
- [ ] `groups` — id, name, sort_order
- [ ] `user_groups` — user_id, group_id
- [ ] `conversations` — id, type ('internal' | 'external' | 'internal_thread'), parent_conversation_id (nullable self-ref FK), display_name (nullable), created_at
- [ ] `conversation_members` — conversation_id, user_id (nullable), external_identity_id (nullable), joined_at, last_read_message_id, muted_until
- [ ] `external_identities` — id, email, phone (nullable), display_name, firm_client_ref (nullable, staff's internal client identifier), verification_type ('ssn' | 'ein' | 'none'), verification_last4_hash (bcrypt), verification_required (bool), preferences JSONB, first_invited_at, last_active_at
- [ ] `access_codes` — id, external_identity_id, code_hash (bcrypt), sent_to, sent_via ('email' | 'sms'), created_at, expires_at, attempts, used_at (nullable)
- [ ] `client_sessions` — id, external_identity_id, session_token_hash, created_at, verified_until (step-up verification expiry), revoked_at (nullable)
- [ ] `conversation_keys` — id, conversation_id, wrapped_keys JSONB (maps user_key_id or session_id → wrapped key), rotation_version
- [ ] `messages` — id, conversation_id, sender_id (nullable), sender_external_identity_id (nullable), ciphertext (bytea), content_key_version, urgent (bool), scheduled_for (nullable), source ('app' | 'email-in' | 'sms-in' | 'system'), created_at, edited_at, deleted_at
- [ ] `attachments` — id, message_id, filename_ciphertext, mime_type, size_bytes, storage_path, wrapped_file_key (bytea), created_at
- [ ] `read_receipts` — message_id, user_id (nullable), external_identity_id (nullable), read_at
- [ ] `user_presence` — user_id (PK), socket_count, last_heartbeat_at
- [ ] `sms_opt_ins` — external_identity_id (PK), opted_in_at, opted_out_at (nullable), last_stop_keyword_at, provider ('textlink' | 'twilio')
- [ ] `audit_log` — id, actor_user_id (nullable), actor_external_identity_id (nullable), action, target_type, target_id, details JSONB, created_at
- [ ] Knex migrations in plain JS
- [ ] Seed: Kurt + test accounts, Payroll/Tax/Admin groups
- [ ] DB integrity checks

---

## Phase 2 — Backend auth & user/group management

- [ ] Express scaffolding: helmet, cors, rate-limit, body parser, session
- [ ] Staff password hashing: bcrypt cost 12
- [ ] Session store: connect-pg-simple
- [ ] `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password`
- [ ] `GET /users`, `GET /users/:id`
- [ ] Admin CRUD for users and groups
- [ ] Avatar upload (encrypted-at-rest on disk)
- [ ] Unit tests for auth + permission checks

---

## Phase 3 — Cryptography foundation

This is now foundational, not a late-stage addition. Everything built after this depends on it.

- [ ] Wrap libsodium via `libsodium-wrappers` in both server and browser; mirror API in `packages/crypto`
- [ ] Core primitives: `encryptMessage`, `decryptMessage`, `wrapKey`, `unwrapKey`, `generateKeypair`, `deriveKeyFromPassword` (Argon2id), `rotateConversationKey`
- [ ] Firm master keypair: generated once during admin setup; public key stored server-side; private key encrypted with the 24-word recovery phrase and also cached in memory at boot
- [ ] Recovery phrase: BIP-39-style 24-word English phrase displayed once to managing partner during install; printable; required for emergency decryption and for firm-key rotation
- [ ] Staff device enrollment: on first login per device, browser generates X25519 keypair → private key encrypted with Argon2id-derived key from password → uploaded to `user_keys` with a `device_id`
- [ ] Device revocation: staff can revoke any device; admin can revoke all devices for a user on termination
- [ ] Conversation key: XChaCha20-Poly1305 symmetric key; wrapped once per authorized member (per device for staff, per session for clients), stored in `conversation_keys.wrapped_keys`
- [ ] Membership-change rewrap: add/remove triggers key rotation (simplest) or incremental wrap (optimization)
- [ ] Emergency access: admin initiates "decrypt conversation for audit" flow → must provide recovery phrase → audit log entry → one-time decryption of specified conversation
- [ ] Key version tracking for rotation migrations
- [ ] Crypto test suite: test vectors, round-trips, rotation, recovery, corrupt-ciphertext, malformed-wrapped-key
- [ ] Performance benchmark: encryption/decryption under load (target: ≤10ms per message on NucBox M6-class hardware, including key unwrap)

---

## Phase 4 — Backend messaging API (encrypted throughout)

- [ ] `GET /conversations` — list with unread count + encrypted last-message blob (decrypted client-side)
- [ ] `POST /conversations` — create/find; auto-generates conversation key wrapped to creator's devices
- [ ] `GET /conversations/:id/messages` — paginated ciphertext + wrapped-key metadata
- [ ] `POST /conversations/:id/messages` — accept ciphertext + per-recipient wrapped keys (or derive from conversation key on server using already-wrapped key)
- [ ] `PATCH /messages/:id` — edit within 15 min (re-encrypt new content, preserve IV rules)
- [ ] `DELETE /messages/:id` — soft delete (wipe ciphertext after retention window = crypto-shred)
- [ ] `POST /messages/:id/read` — mark read
- [ ] Search endpoint **removed** (replaced with client-side; see Phase 10)
- [ ] `POST /conversations/:id/attachments` — multipart ciphertext upload + wrapped file key
- [ ] `GET /attachments/:id` — streams ciphertext to client
- [ ] `POST /conversations/:id/members` — add/remove; triggers rewrap
- [ ] Scheduled-message cron: stores ciphertext in `messages.ciphertext` with future `scheduled_for`; simply flips visibility at send time
- [ ] Integration tests (end-to-end encrypt → decrypt round trips)

---

## Phase 5 — Real-time layer (Socket.io + presence)

- [ ] Socket.io with session auth (staff) or client-session-token auth (clients)
- [ ] Presence via `user_presence` + heartbeat
- [ ] Rooms per conversation
- [ ] Events: `message:new`, `message:edit`, `message:delete`, `message:read`, `presence:update`, `typing:start/stop`
- [ ] Postgres `LISTEN/NOTIFY` fanout on `connect_events`
- [ ] Payload is ciphertext; real-time decryption happens on each client
- [ ] Load test: 50 concurrent users, ≤200ms delivery on NucBox M6

---

## Phase 6 — Frontend scaffolding (staff app)

- [ ] Vite + React + TS + Tailwind
- [ ] App shell: sidebar + main panel
- [ ] Routing: `/login`, `/`, `/conversation/:id`, `/admin/*`, `/enrollment` (first-login device key setup)
- [ ] Auth context + protected routes
- [ ] TanStack Query for server state + small Zustand store for UI
- [ ] `useRealtime` hook that invalidates TanStack Query caches on socket events
- [ ] `useCrypto` hook exposing decryption/encryption functions scoped to current user + device
- [ ] Transparent decrypt-on-read: message list components receive plaintext via hook; no component sees ciphertext
- [ ] Design tokens: blue accent, neutral professional; NOT pink
- [ ] Light theme; dark theme deferred

---

## Phase 7 — Frontend: user list + presence sidebar

- [ ] Collapsible group headers (Payroll, Tax, Admin, Clients)
- [ ] User rows: avatar, name, presence dot, last-seen
- [ ] External members shown in the Clients group with external pill label
- [ ] Click → open/create DM
- [ ] Filter search
- [ ] Unread badges
- [ ] Multi-select for ad-hoc group
- [ ] Admin drag-reorder groups and user assignments

---

## Phase 8 — Frontend: conversation view + compose

- [ ] Header: partner(s) + presence
- [ ] Message list: reverse-chronological, day-grouped, decrypted on the fly
- [ ] Infinite scroll upward
- [ ] Auto-scroll on new message (unless scrolled up)
- [ ] Compose: textarea, attach, send; no subject line
- [ ] Enter sends, Shift+Enter newline
- [ ] Paste/drag image → encrypted attachment upload
- [ ] Minimal markdown: `**bold**`, `_italic_`, autolink
- [ ] Context menu: edit/delete/copy
- [ ] Urgent flag indicator

---

## Phase 9 — Urgent flag, send later, read receipts

- [ ] Urgent toggle + distinct notification sound
- [ ] Send later: datetime picker; scheduled items visible in "Scheduled" view; editable/cancellable before send
- [ ] Read receipts below own messages
- [ ] Ack button (separate from read)

---

## Phase 10 — Unread counts + inbox view + client-side search

- [ ] Sidebar unread badges
- [ ] Inbox view matching PinkNotes Open mode
- [ ] **Client-side search**: FlexSearch instance in browser indexing decrypted messages; index persisted in IndexedDB under a key derived from the user's password (so logout wipes readable index)
- [ ] On new message arrival: decrypt → index
- [ ] On login: rebuild index from cached ciphertext if no valid local index exists (shows a "Indexing your messages..." progress step on first login per device)
- [ ] Jump-to-message from search result
- [ ] Keyboard shortcuts: Ctrl+K quick switch, Ctrl+F search, Esc close

---

## Phase 11 — Admin UI

- [ ] `/admin` gated on `is_admin`
- [ ] Users / Groups / Settings / Audit log / Device health tabs
- [ ] Firm name + logo
- [ ] Retention policy (triggers crypto-shredding)
- [ ] Per-conversation export to text/PDF (requires recovery phrase for external conversations as a safeguard — admin can mark "allow without phrase" for internal-only exports)
- [ ] Bulk user CSV import
- [ ] Device health tab: table of every enrolled device (user, platform, client_version, last_heartbeat_at, status), with automatic flags for (a) installs > 14 days behind the latest shipped version (`update_drift`), (b) installs with no heartbeat in > 7 days (`stale`), (c) installs reporting a version the server doesn't recognize (`unknown_version`). Each flag shows a plain-English explanation + remediation hint. Admin can revoke any device's keys from this view.
- [ ] Persistent admin banner shown site-wide whenever any device has `update_drift` status for > 14 days — forces admin to acknowledge or dismiss so update failures don't go silently unnoticed.

---

## Phase 12 — Notifications

- [ ] Tab title unread badge + favicon dot
- [ ] Web Notifications API with urgent-distinct sound
- [ ] Web Push for PWA (VAPID)
- [ ] Important: push notification payload contains only metadata (conversation id, sender id), never message content — client fetches + decrypts on wake
- [ ] Email fallback for urgent offline messages (content intentionally NOT included in email; only "you have an urgent message — open [portal/app]")
- [ ] Per-user DND schedule with urgent override
- [ ] Notification preferences UI

---

## Phase 13 — Desktop app (Tauri 2.x)

- [ ] Create `apps/desktop` as a Tauri 2.x project; configure it to load the staff web bundle from `apps/web` at build time (no separate frontend code)
- [ ] System tray + unread overlay via `tauri-plugin-tray` (built into 2.x core)
- [ ] Minimize to tray on window close (don't quit) — handled in Rust shell's window-event handler; minimal Rust
- [ ] Auto-start on boot via `tauri-plugin-autostart`
- [ ] Native desktop notifications via `tauri-plugin-notification`
- [ ] Global hotkey (configurable show/hide) via `tauri-plugin-global-shortcut`
- [ ] Auto-update via `tauri-plugin-updater`: Ed25519-signed update manifest hosted on your release CDN (GitHub Releases works) + Ed25519-signed binaries; generate signing keypair once, guard the private key offline
- [ ] Code signing: Windows EV certificate (for Authenticode), macOS Developer ID + notarization — same cost and process as any desktop app
- [ ] Capability configuration in `tauri.conf.json`: deny-by-default; explicitly allow only (a) HTTPS requests to the configured server URL, (b) file read/write in app data directory, (c) notification, autostart, tray, global-shortcut, updater plugins. No shell access, no arbitrary filesystem access.
- [ ] Installer builds via `tauri build`: Windows `.msi` + `.exe` (NSIS), macOS `.dmg` + universal binary, Linux `.AppImage` + `.deb`
- [ ] First-launch setup wizard (in the web bundle): prompt for server URL + device enrollment; persist in `tauri-plugin-store`
- [ ] Per-install device key enrolled via first login (same flow as Phase 3 crypto; keys stored in encrypted IndexedDB inside the webview, not in Rust-side storage)
- [ ] Version heartbeat: desktop app POSTs `{client_version, client_platform}` to `/api/devices/heartbeat` on launch and once every 24 hours; server updates `user_keys.client_version` and `user_keys.last_heartbeat_at` for the current device. Same endpoint used by PWA clients so admin sees a unified device health view.
- [ ] WebView2 runtime note: Windows 10 users may need the WebView2 runtime; check `tauri.conf.json` bundler config for whether to include the bootstrapper or require existing runtime — most Windows 10/11 machines have it pre-installed via Windows Update
- [ ] Smoke test install + launch + tray + notification + update cycle on Windows 10, Windows 11, macOS Sonoma (x86 + Apple Silicon)
- [ ] Document update-signing-key backup and rotation procedure in `docs/ops/UPDATE_SIGNING.md`

---

## Phase 14 — Mobile PWA polish (staff)

- [ ] Responsive down to 360px
- [ ] Service worker + offline shell
- [ ] Web Push subscription
- [ ] Add-to-home-screen
- [ ] Touch gestures
- [ ] Lighthouse: PWA ≥ 90, Perf ≥ 85, A11y ≥ 95
- [ ] Device key stored in encrypted IndexedDB

---

## Phase 15 — Appliance packaging

- [ ] Multi-stage Alpine Dockerfile, image < 350 MB
- [ ] `docker-compose.yml`: app + Postgres 16 + attachments volume + optional Redis for TextLink-bridge polling
- [ ] `/health` endpoint
- [ ] Env vars: DATABASE_URL, SESSION_SECRET, SITE_URL, PORTAL_URL, VAPID_*, EMAIL_*, SMS_PROVIDER, TEXTLINK_API_KEY or TWILIO_*, S3_*
- [ ] First-boot admin setup: create admin user + firm name + generate recovery phrase + display once
- [ ] Nginx sample with WS upgrade headers, separate hostnames for staff app vs client portal
- [ ] Tailscale-friendly deployment
- [ ] Duplicati backup: Postgres dump + attachments volume + encrypted firm key material (recovery phrase NOT in backup — held separately by partner)
- [ ] UFW rules
- [ ] Hardware sizing guide

---

## Phase 16 — Third-party crypto review

- [ ] Engage a crypto-literate reviewer (1–2 week engagement, $3–6k)
- [ ] Review scope: key generation, storage, wrapping/unwrapping, rotation, recovery, the Argon2id parameters, the wrapping formats, any custom protocol elements, the threat model doc
- [ ] Fix every critical or high finding before proceeding
- [ ] Document review outcomes in `SECURITY_REVIEW.md`
- [ ] **Do not proceed to Phase 17 until review is signed off**

---

## Phase 17 — Rollout to own firm (Kisaes)

- [ ] Deploy alongside PinkNotes on Kisaes NucBox
- [ ] Create accounts for Kurt + staff; replicate group structure (Payroll, Tax, Admin, Users)
- [ ] First-login device enrollment for each staff member
- [ ] Kurt receives and safely stores the firm recovery phrase
- [ ] Install desktop app + PWA for each staff member
- [ ] "PinkNotes vs Vibe Connect" training 1-pager
- [ ] Week 1: Kurt exclusive
- [ ] Week 2: opt-in staff
- [ ] Week 3: full staff with PinkNotes parallel
- [ ] Weeks 4–6: daily feedback
- [ ] 24h SLA for critical bugs
- [ ] End of week 6: decide retire vs extend parallel run

---

## Phase 18 — Iterate from real internal use

- [ ] Feedback tracking
- [ ] Prioritize by frequency × impact
- [ ] Likely adds: archiving, star/pin, print-to-PDF
- [ ] Dark theme if demanded
- [ ] Per-user notification sounds if demanded
- [ ] **Don't start client features until internal is demonstrably stable for ≥ 4 weeks**

---

## Phase 19 — Client portal + access code login

This is the client-side entry point. Push-invite via email/SMS and pull-access via portal both converge on the same session model.

- [ ] Separate client portal bundle at `apps/portal`, served at distinct subdomain (e.g., `portal.firmdomain.com`)
- [ ] Landing page: firm logo, "Enter your email or phone to access your messages from [Firm]"
- [ ] Identify flow: POST email or phone → server looks up `external_identities` → if match, generates 6-digit code + sends via same channel that matched
- [ ] No-match behavior: same "code sent" message shown to prevent user enumeration; no code actually sent
- [ ] Code entry page: 6-digit input with paste support
- [ ] Rate limits: 3 code requests per identity per 10 min; 5 wrong attempts per code then invalidate
- [ ] Code correct → create `client_sessions` row → issue httpOnly session cookie
- [ ] Invite email/SMS from staff: contains pre-filled portal URL (`portal.firmdomain.com?hint=<email-hash>`) so client lands directly on code-entry without needing to re-type their email
- [ ] Session refresh: codes are single-use; session uses sliding expiry (30 min idle / 8h absolute)
- [ ] Logout / session revoke: staff can revoke any client session from admin

---

## Phase 20 — SSN/EIN step-up verification

- [ ] Staff invite flow: admin/staff enters client's last 4 of SSN or EIN at invitation time; required unless admin toggles off per-client
- [ ] Stored as bcrypt hash in `external_identities.verification_last4_hash`
- [ ] After access-code login, check `client_sessions.verified_until`:
  - If valid: skip to messages
  - If expired or null: prompt "Please verify your identity. Last 4 digits of your [SSN/EIN]:"
- [ ] 3 wrong attempts → invalidate session, require re-auth via new access code
- [ ] Correct → set `verified_until = now + <timeout>`; timeout configurable per firm (default 24h; options 4h / 8h / 24h / 7d / never)
- [ ] Admin can reset a client's stored last-4 if they forget (rare; logs the event)
- [ ] Admin can disable verification per-client for clients without SSN/EIN (e.g., foreign corporate clients)
- [ ] The verification check happens server-side and gates delivery of conversation keys to the client session — a client without valid `verified_until` can't decrypt messages even if they've intercepted the session cookie

---

## Phase 21 — Client conversation UI + secure document upload

- [ ] Minimal portal UI: single-column, firm logo, conversation list, active conversation
- [ ] No sidebar chrome, no staff-app features
- [ ] Message composition with attach button
- [ ] Client-side file encryption: per-file XChaCha20-Poly1305 key; file key wrapped to conversation key
- [ ] Chunked resumable upload (tus protocol)
- [ ] Max file 100 MB v1; file-type allowlist: PDF, JPG/PNG/HEIC, DOCX, XLSX, CSV, TXT
- [ ] Post-upload decryption in isolated ClamAV sandbox for virus scan → re-encrypt if clean, quarantine if not
- [ ] Download: streaming decryption via `ReadableStream`
- [ ] UI states: "Encrypting → Uploading → Scanning → Delivered" / "Blocked (virus)"
- [ ] Staff-to-client file sends use same flow
- [ ] No server-generated thumbnails (would require decryption on server)

---

## Phase 22 — Email bridge (inbound)

- [ ] Per-conversation address: `c+<opaque-token>@connect.firmdomain.com`
- [ ] Transport: Postmark inbound webhooks (primary); self-hosted Postfix alternative
- [ ] Parse MIME; extract text/plain preferred, text/html fallback; extract attachments; strip quotes/signatures with `email-reply-parser`
- [ ] Sender verification: accept only if From matches `external_identities.email`; otherwise bounce with user-friendly message
- [ ] Encrypt at gateway: plaintext → immediate encryption with conversation key → `messages.ciphertext` populated → `source='email-in'`
- [ ] Attachments same flow
- [ ] Threading: preserve In-Reply-To / References headers
- [ ] Deliverability: SPF, DKIM, DMARC for bridge domain
- [ ] Bounce handling + auto-reply
- [ ] UI indicator: envelope icon + "via email" label with tooltip explaining encryption-from-gateway-onward
- [ ] SSN/EIN step-up does NOT apply to email-bridged inbound (client already authenticated themselves by having access to the registered email)

---

## Phase 23 — Email bridge (outbound)

- [ ] Trigger policy: staff message to client + client last-active > 24h (admin-configurable), OR urgent flag, OR client preference "always email me"
- [ ] Two modes (admin toggle per firm):
  - **Summary mode:** "New message from [Firm] — click to view [portal URL]"; no content in email
  - **Content mode:** message preview (first ~200 chars) included; riskier but higher engagement
- [ ] Reply-To: per-conversation inbound address (closes the loop with Phase 22)
- [ ] DKIM signing, SPF, DMARC reporting
- [ ] Unsubscribe / preferences link → client preferences page (accessible via portal login)
- [ ] Delivery tracking: sent / delivered / bounced / complained; auto-flag bounced emails in admin UI
- [ ] Per-recipient rate-limiting to prevent notification spam

---

## Phase 24 — Internal-only side-thread

- [ ] Data model already supports via `conversations.parent_conversation_id`
- [ ] On creation of an external conversation, auto-create linked `internal_thread` with all current staff members of the parent
- [ ] Staff add/remove on parent propagates to side-thread
- [ ] Clients NEVER members; server enforces at API layer
- [ ] Side-thread is E2EE like everything else, but the conversation key is wrapped ONLY to staff device keys, never to any client session
- [ ] UI: tab toggle at top of conversation view: "With client" | "Team notes" — unread badges per side
- [ ] Independent notification stream + DND settings
- [ ] Export: conversation export offers "Include team notes" checkbox; default off for client-record exports, on for internal-audit exports
- [ ] Audit safeguard: every side-thread export is logged with actor + reason

---

## Phase 25 — SMS bridge with TextLink (primary) + Twilio (alternative)

- [ ] Define `SmsProvider` interface: `sendMessage({ to, body })`, `onInboundMessage(handler)`, `verifyWebhookSignature(req)`
- [ ] TextLink adapter:
  - Dedicated Android phone running TextLink app, paired with firm's appliance
  - Outbound: POST to `https://textlinksms.com/api/send-sms` with API key
  - Inbound: TextLink webhook to appliance endpoint; verify shared secret; parse body
  - Setup documentation: which phone to buy, how to configure, where to place (office)
- [ ] Twilio adapter:
  - Required for firms unable or unwilling to run the Android phone
  - 10DLC brand + campaign registration (2–4 weeks external gating)
  - Twilio webhook with signature verification
- [ ] Admin UI: choose provider, enter credentials, test send
- [ ] TCPA compliance (both providers): explicit opt-in required before any outbound SMS; `sms_opt_ins` records opt-in event with source
- [ ] STOP keyword handling: inbound STOP / UNSUBSCRIBE / CANCEL → immediate opt-out, auto-reply confirming, `opted_out_at` set, no further SMS ever until new opt-in
- [ ] START / UNSTOP re-opt-in
- [ ] Outbound SMS content: short body + "Reply at [shortlink to portal]" — shortlink points at firm's own portal URL
- [ ] Inbound SMS: webhook → match phone → encrypt at gateway → `messages.ciphertext` + `source='sms-in'` + "via SMS" indicator
- [ ] Time-of-day guardrails: no SMS 9pm–8am recipient-local unless urgent (recipient timezone from preferences)
- [ ] Per-firm monthly SMS cap with admin alerts at 80% / 100% (cost protection for Twilio; less relevant for TextLink since SIM plan is flat)
- [ ] Admin audit view: all SMS sent, per-recipient opt-in trail, TCPA-defense exportable
- [ ] SSN/EIN step-up does NOT apply to SMS-bridged inbound (possession of phone is the factor)

---

## Suggested ordering & parallelism

- Phases 0 → 5 strictly sequential (foundation: data model → auth → crypto → messaging API → real-time)
- Phases 6 → 10 mostly sequential for the staff app, though 7/8/9 can overlap once 6 lands
- Phases 11, 12, 13, 14, 15 parallelize
- Phase 16 (crypto review) gates Phase 17
- Phase 17 (rollout) and Phase 18 (iterate) are sequential and must complete stably before any client feature
- Phase 19 → 20 → 21 sequential (portal → step-up → client UI)
- Phases 22, 23, 24 can parallelize with 21
- Phase 25 last — TextLink hardware shipping or Twilio 10DLC approval externally gated

## Realistic timeline

With Claude Code on Kurt's usual cadence:

- Phases 0–5 (foundation + crypto + messaging): **10–12 weeks**
- Phases 6–10 (staff frontend, incl. client-side search): **6–8 weeks**
- Phases 11–15 (admin, notifications, desktop, mobile, appliance): **4–6 weeks**
- Phase 16 (crypto review): **2–3 weeks calendar**
- Phase 17 (rollout): **4–6 weeks calendar**
- Phase 18 (stabilize internal): **4–6 weeks calendar**
- Phase 19 (portal + access code): **2 weeks**
- Phase 20 (step-up verification): **1 week**
- Phase 21 (client UI + secure upload): **2–3 weeks**
- Phase 22 (email in): **2–3 weeks**
- Phase 23 (email out): **1–2 weeks**
- Phase 24 (side-thread): **1 week**
- Phase 25 (SMS): **2–3 weeks** (TextLink faster than Twilio)

**Total: ~10–13 months from kickoff to full client connectivity.** Internal v1 with E2EE running at Kisaes around weeks 24–28; first encrypted client conversation around weeks 40–48.

## Definition of done

- Kisaes has been running on Vibe Connect exclusively for ≥ 60 days with no critical incidents, all staff using E2EE-protected devices
- Third-party crypto review complete with no unresolved critical findings
- At least one client conversation running end-to-end (portal login, SSN/EIN step-up, secure upload, email-in/out, side-thread) for ≥ 30 days
- Admin can produce a decrypted conversation export via recovery phrase within 5 minutes
- Fresh appliance install reaches first staff message in < 30 minutes
- Fresh client invite reaches first client reply (via portal) in < 10 minutes
- Backup restore to fresh appliance with zero data loss, including encrypted conversation access, in < 15 minutes
- Both SMS providers tested and switchable via config

## Cross-cutting concerns

- **Crypto review budget:** $3–6k for Phase 16; this is not negotiable given CPA firms' handling of PII.
- **Security posture doc:** aligned with IRS Pub 4557 Safeguards Rule and GLBA language. Position as "firm-controlled E2EE with audit-ready recovery" — never "zero-knowledge" (which would be a lie because the firm recovery phrase can decrypt).
- **Bridged-message honesty:** every email-in / SMS-in message must visibly indicate source and non-end-to-end original transit. Never imply otherwise in UI or marketing.
- **Recovery phrase handling:** physical card or sealed envelope given to managing partner on install; document unambiguously that lost phrase = permanent loss of access to all client conversations the holder was in. Consider offering Shamir Secret Sharing split across multiple partners in a future phase for multi-partner firms.
- **TCPA:** SMS opt-in audit trail is a legal requirement; shippable only if Phase 25's audit features work correctly.
- **Email deliverability:** bridge domain needs proper SPF/DKIM/DMARC before first outbound; document clearly in setup.
- **Retention via crypto-shredding:** destroying wrapping keys for expired conversations makes the ciphertext permanently unreadable; admin retention settings trigger this cleanly without needing to overwrite message rows.
- **Backup pairing:** Postgres dump + attachments + encrypted firm key material are all required together; backup without key material = useless. Recovery phrase is NOT in backup (held separately by partner). Document this pairing in recovery runbook.
- **Client-side search index:** stored in encrypted IndexedDB; wiped on logout; rebuilt on next login. First-login index rebuild is slow for users with large history — show progress UI.
- **TextLink hardware:** dedicated Android phone + SIM with unlimited SMS plan; phone lives in firm office; must stay connected to power + carrier signal. Document failure modes (phone dies → SMS stalls; fall back to Twilio if configured as secondary).
- **Tauri update signing key:** Ed25519 private key generated once during Phase 13, guarded offline, backed up in two physical locations. Treat it with the same care as the firm recovery phrase from Phase 3 — losing it means you can't ship updates; leaking it means someone else can push malicious updates that run as your app on every installed workstation. Rotation procedure documented in `docs/ops/UPDATE_SIGNING.md`; key rotation requires a one-time "please re-install" notice to customers since the old public key is baked into their installed binaries.
- **Telemetry:** none, ever. Firm-local logs only.
