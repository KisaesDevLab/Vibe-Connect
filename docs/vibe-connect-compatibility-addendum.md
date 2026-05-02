# Vibe-Connect — Appliance Compatibility Addendum

Companion to `docs/PLAN.md` (the Vibe-Appliance plan) and to `vibe-appliance-emergency-access-addendum.md`. This document specifies the changes needed in `KisaesDevLab/Vibe-Connect` so that a single set of GHCR images runs cleanly in two deployment modes:

- **Standalone:** customer runs the app's existing install path; bundled Postgres + Redis + workers; current behavior, must not regress.
- **Appliance:** the Vibe-Appliance composes Vibe-Connect alongside other Vibe apps; shared Postgres + Redis; behind Caddy at `connect.<domain>` (staff) and `client.<domain>` (client portal) — with three documented access methods.

Connect is the most architecturally complex Vibe app for the appliance to integrate because of four things: **multi-subdomain routing** (staff and client portal on separate subdomains), **WebSockets** (Socket.io for real-time messaging), **firm-held E2EE key material** that must not be lost, and **client-facing magic-link auth** that breaks in unobvious ways if `PUBLIC_URL` is wrong.

---

## 0. PREREQUISITE: License change (BLOCKER)

**Vibe-Connect's current license is "Proprietary, internal use." This blocks all appliance integration work.**

Open a PR against `KisaesDevLab/Vibe-Connect` with two changes:

1. Replace the README "Proprietary, internal use" wording with a section titled "License" pointing at the new `LICENSE` file.
2. Add a `LICENSE` file at the repo root containing the full Elastic License 2.0 text (identical to Vibe-MyBooks's `LICENSE`).

This is a one-PR change, mergeable in under 10 minutes. **Until it merges, none of the work in sections 1–9 below can be released to customers** — you can build internally, but appliance customers can't legally receive Connect images.

This blocker is independent of all other appliance work. Open the license PR immediately, even before reading the rest of this document.

---

## 1. Design principles

Same three rules as the other addenda. If a future change violates one, push back.

1. **Standalone behavior must not change for existing customers.** Identical setup, identical defaults, identical first-login flow after this work ships.
2. **One image, two modes.** Same `ghcr.io/kisaesdevlab/vibe-connect-*` images run both standalone and appliance.
3. **Configuration over forks.** Every behavioral difference is an env var or compose overlay.

Plus one Connect-specific rule:

4. **The firm key is sacred.** Loss of `vibe-connect-keys` volume = loss of all E2EE data across all clients and conversations. **Backup verification is non-negotiable** — the appliance must verify the backup destination is configured before allowing Connect to enter production use, and the app should refuse to start in single-instance/no-backup configurations after a grace period.

---

## 2. Audit summary

| Item | Today | Target | Notes |
|---|---|---|---|
| **License** | **Proprietary** | **ELv2** | **§0 BLOCKER** |
| Stack | React 18 + TS + Node 20 + Express + Socket.io + PG16 + Redis + libsodium + Tauri 2 desktop | Same | No stack changes |
| Standalone install | Existing flow | Unchanged | Audit |
| GHCR images | Need verification | Multi-arch (amd64 + arm64), three image families: server, web, portal | §5.10 |
| DB / Redis config | Mixed assumed | `DATABASE_URL` / `REDIS_URL` only | §3 (common) |
| `ALLOWED_ORIGIN` | Likely single-value | Comma-separated list with regex | §3 (common) |
| Migrations | Auto on startup | Gated by `MIGRATIONS_AUTO` (default `true`) | §3 (common) |
| `/health` + `/ping` | Need verification | Distinct endpoints; health checks DB+Redis+keys; ping is liveness only | §5.4 |
| Workers | Email, SMS, push, file processing | Env-driven, heartbeats to Redis | §3 (common) |
| Logs | Mixed | Stdout/stderr structured JSON | §3 (common) |
| **Subdomain count** | **Single (assumed)** | **Two: staff + client portal** | §5.1 |
| **WebSocket support** | Socket.io on `:4000` | Must transparently traverse Caddy AND HAProxy | §5.3 |
| **Firm E2EE key** | Volume-stored, libsodium | `vibe-connect-keys` volume, mandatory backup verification | §5.4 |
| **Magic-link auth** | Currently working | `PUBLIC_URL` env var; emails embed `https://client.firm.com/...` | §5.6 |
| **SSN/EIN step-up** | Working | Audit no domain-specific assumptions | §5.6 |
| **Cookie scoping** | Need verification | Per-subdomain (no `.firm.com` wildcard) — staff and client must NOT share session | §5.2 |
| Email provider | Currently? | `EMAIL_PROVIDER` abstraction (Resend / Postmark / SMTP) | §5.5 |
| SMS provider | TextLink primary, Twilio fallback | `SMS_PROVIDER` abstraction same as Payroll-Time; TextLink default | §5.5 |
| Push notifications | If implemented | Web Push requires HTTPS — disable on emergency mode | §5.8 |
| Tauri desktop | Standalone artifact, separate distribution | Works fine — just a Chromium client; no appliance integration needed | §5.9 |
| `PUBLIC_URL` | Likely uses `ALLOWED_ORIGIN` | Dedicated env per subdomain: `PUBLIC_URL_STAFF` and `PUBLIC_URL_CLIENT` | §5.7 |
| Compose files | `docker-compose.yml` | Add `docker-compose.appliance.yml` (3 services + shared infra refs) | §5.10 |
| Manifest | None | `.appliance/manifest.json` with multi-subdomain + emergency ports `5181`/`5182` | §5.11 |
| Volumes | Bundled | Bundled in standalone; named-volume references in appliance | §5.12 |
| Emergency-access compatibility | Likely fails | Audited; client portal emergency is staff-debug-only | §5.13 |

---

## 3. Common-requirements pass

Items 1–10 of PLAN.md §8.1 apply to Connect without per-app variation. Same audits and fixes as MyBooks (§3.1–3.7, 3.9, 3.12). Worth specifically noting for Connect:

- **DB/Redis config consolidation.** Connect's Redis usage is heavier than other apps (Socket.io adapter for pub/sub, BullMQ workers, session store). All paths must use `REDIS_URL`.
- **`/ping` endpoint must be reachable on both server *and* Socket.io transport paths.** HAProxy emergency probes the HTTP path; Caddy's WebSocket health check is independent.
- **Workers must heartbeat to Redis** so the server's `/health` knows whether email/SMS dispatch is working. A failed worker that the server doesn't know about means magic-link emails silently never send — exactly the kind of "looks fine, isn't" failure that hurts client trust.

---

## 4. Three access methods × three audiences

Connect has three audiences (staff, admin, client) and the appliance offers three access methods. Some combinations are practically meaningless and should be documented as such.

|  | Primary domain<br>(`connect.firm.com` / `client.firm.com`) | Tailscale<br>(`connect.<tailnet>.ts.net`) | Emergency<br>(`:5181` / `:5182`) |
|---|---|---|---|
| **Staff** (preparers, partners) | ✅ Full | ✅ Full | ⚠️ No push, no service worker — staff messaging works |
| **Admin** (firm admin) | ✅ Full | ✅ Full | ⚠️ Same as staff |
| **Client** (external) | ✅ Full | ❌ Clients aren't on the tailnet | ❌ See §4.2 |

### 4.1 Staff and admin: emergency mode is workable

Real-time messaging over WebSockets works on plain HTTP (`ws://`). Staff can keep messaging through emergency mode if Caddy is down. What breaks:

- **Web Push.** Service worker won't register on HTTP, so push notifications stop. Staff don't get desktop alerts for new messages — they must keep the tab open and visible.
- **PWA install / "Install Connect to home screen" prompt.** Hidden in emergency mode.
- **Image/file thumbnails fetched from cross-origin CDN** (if any). Browsers may block mixed content.

The staff Tauri desktop wrapper (§5.9) is a Chromium-with-extras that respects whatever URL the user configured; it works on all three methods including emergency. Staff who use the desktop app bypass browser-side push restrictions because Tauri uses native OS notifications.

### 4.2 Client emergency mode is genuinely broken

The client portal subdomain has an emergency port (`:5182`) — but **it's there for staff to debug the client portal, not for actual client access**. Three reasons:

1. **Clients aren't on the LAN.** A CPA's client lives wherever they live; they reach the firm's Connect through public DNS at `client.firm.com`. The emergency port is reachable only from RFC1918 ranges and the tailnet.
2. **Magic-link emails contain primary URLs.** Emails sent to clients reference `https://client.firm.com/auth/magic?token=...` (per `PUBLIC_URL_CLIENT`, §5.7). Clients can't override these URLs to point at the LAN even if they wanted to.
3. **SSN/EIN step-up over plain HTTP is unsafe.** The whole point of the second factor is to keep credentials confidential in transit. Plain HTTP across a public network would expose them. The app should **refuse step-up auth over HTTP** as a defensive default.

The client emergency port exists so a staff member on the LAN can verify "is the client portal container running?" and "does the login page render?" without going through the public domain. It is NOT a fallback for clients during outages.

The manifest's `emergencyNote` says exactly this, surfaced in the admin console and CREDENTIALS.txt.

### 4.3 What customers should be told

Document explicitly in the customer-facing install guide:

> **Connect access during outages**
>
> Staff: if `https://connect.firm.com` is unreachable, use `https://connect.<your-tailnet>.ts.net` (Tailscale required). As a last resort, staff on the office LAN can use `http://<server-ip>:5181`.
>
> Clients: if `https://client.firm.com` is unreachable, **clients have no fallback access during the outage**. The client portal is reachable only via the public domain. If a client urgently needs to share a document during an outage, fall back to email or phone.
>
> This is by design. The client portal is the most security-sensitive surface in the appliance, and exposing it via insecure paths would defeat the E2EE and step-up auth that protect client data.

---

## 5. Connect-specific changes

### 5.1 Multi-subdomain layout

**Goal.** Staff at `connect.firm.com`, clients at `client.firm.com`. Each subdomain serves a different web app from a different container, both backed by the same server.

**Action.**

- Three running containers in appliance mode:
  - `vibe-connect-server` — Express + Socket.io API server, listens on `:4000` internally.
  - `vibe-connect-web` — staff SPA, served by nginx on `:80` internally. Proxies `/api/*` and `/socket.io/*` to the server.
  - `vibe-connect-portal` — client portal SPA, served by nginx on `:80` internally. Proxies `/api/*` and `/socket.io/*` to the server.
- Caddy routing:
  - `connect.firm.com` → `vibe-connect-web:80` (with WebSocket pass-through to server).
  - `client.firm.com` → `vibe-connect-portal:80` (with WebSocket pass-through).
- Server-side routing distinguishes staff and client requests by inspecting the originating `Host` header *and* the auth token's `audience` claim. **Audience mismatch must result in 403** — a client token presenting at `connect.firm.com` is a security violation, and vice versa.

**Tests.**

- Staff token used at `client.firm.com` → 403, not redirect, not 404.
- Client token used at `connect.firm.com` → 403.
- Staff at `connect.firm.com` can WebSocket-subscribe to staff channels.
- Client at `client.firm.com` can WebSocket-subscribe only to threads they're a participant in.

**Standalone impact.** Standalone customers running both subdomains today behave the same. Standalone customers running only one (e.g., staff-only deploys) continue to work — the unused container can be omitted via compose profile.

### 5.2 Cookie domain scoping

**Goal.** Staff session cookies and client session cookies must NEVER cross-pollinate. A client visiting `client.firm.com` must not have staff cookies sent in the request, and vice versa.

**This is a real security boundary and easy to get wrong.** The naive default in many cookie libraries is to set `Domain=.firm.com`, which leaks cookies across all subdomains.

**Action.**

- Audit cookie configuration in the server. Cookie `Domain` attribute must be:
  - `connect.firm.com` for staff session cookies.
  - `client.firm.com` for client session cookies.
  - **Never `.firm.com`** (note the leading dot — that's wildcard scope).
- Server detects which audience the request belongs to via the originating `Host` header and sets the cookie accordingly.
- In emergency mode where Host is `<ip>:5181` or `<ip>:5182`, the cookie has no Domain attribute (defaults to host-only) which is the correct behavior — cookies don't leak to the other emergency port because they're different host:port pairs.

**Tests.**

- Authenticate as staff at `connect.firm.com`. Visit `client.firm.com` in the same browser. No staff cookie sent.
- Authenticate as client at `client.firm.com`. Visit `connect.firm.com`. No client cookie sent.
- Authenticate as staff at `:5181` emergency. Visit `:5182` emergency. No cookie sent.
- Cookie inspector: confirm `Domain` attribute is exactly `connect.firm.com` for staff cookies (no leading dot).

**Standalone impact.** Existing customers with both subdomains see no behavior change *if* their setup already uses host-specific cookies. If existing setup uses wildcard `.firm.com` cookies, this is a fix that closes a security hole — flag in release notes.

### 5.3 WebSocket transparency through both proxies

**Goal.** Socket.io WebSocket connections work transparently through Caddy (primary mode) and HAProxy (emergency mode). Long-lived connections, no awkward reconnects on proxy reload.

**Action.**

- Caddy `reverse_proxy` directive supports WebSockets natively when the upstream is HTTP — no special config needed beyond making sure the path matches. Confirm the appliance's Caddyfile template includes `/socket.io/*` in the staff and client routing blocks.
- HAProxy in `mode http` supports WebSocket upgrades via `option http-server-close` and proper `Upgrade`/`Connection` header handling. Default config in the emergency-access addendum already includes this.
- Socket.io transport: prefer `websocket` only (skip `polling`). Polling fallback works behind both proxies too but adds latency. Set `transports: ['websocket']` on both client and server.
- Reconnect handling: client-side Socket.io should reconnect automatically on transient disconnects (network blip, proxy reload). Default Socket.io reconnect policy works; verify it's not been disabled.

**Tests.**

- Open Connect web app at `connect.firm.com`. Send a message. Confirmed delivered in real-time to a second tab.
- Reload Caddy (`docker exec vibe-caddy caddy reload`). The two tabs disconnect briefly, reconnect within 2 seconds, messages flow again.
- Stop Caddy. Switch to emergency URL `:5181` in two tabs. WebSocket connection establishes (over `ws://`). Messages flow.
- Long-lived connection test: leave Connect open for 30 minutes with idle traffic. Confirm no spurious disconnects from proxy timeouts. (HAProxy `timeout client 30s` is correct for HTTP requests but Socket.io connections need longer — server-side `pingInterval` keeps the connection alive within HAProxy's view. Verify this works.)

**Standalone impact.** Standalone setups that already work with WebSockets continue to work. The `transports: ['websocket']` setting may need to be explicit if not already.

### 5.4 Firm E2EE key volume + mandatory backup verification

**Goal.** The firm-held E2EE key file is backed up before the customer puts Connect into production use. Loss of this file is unrecoverable; the appliance enforces backup before letting customers ignore the risk.

**Why this matters disproportionately for Connect.** Other apps lose data if their volumes are lost — bad, but the data is what's stored in the DB. Connect's encrypted vault data and message history are *opaque* without the firm key. Lose the key, and even if you have a perfect backup of the database, every message and every vault file becomes unrecoverable ciphertext. **There is no way to re-derive the key from anything else.**

**Action.**

- Firm key lives in volume `vibe-connect-keys` at path `/app/data/keys/firm.json`. The file contains:
  - The XChaCha20-Poly1305 firm-held key (encrypted at rest with a key derived from `JWT_SECRET` + `ENCRYPTION_KEY` via Argon2id).
  - A version number for key rotation.
  - A creation timestamp and a SHA-256 fingerprint for verification.
- On first start: if no key file exists, the server generates one and writes it. If a key file exists, the server verifies its fingerprint matches the hash stored in the DB's `firm_key_fingerprint` column. Mismatch = refuse to start (corruption or wrong volume mounted).
- On every start: server logs the fingerprint at info level (not the key — the fingerprint, which is safe to log).
- New endpoint `/api/v1/admin/key-status` returns:
  - Fingerprint of currently loaded key.
  - Last successful backup timestamp (read from Duplicati's status API via the appliance console's relay).
  - Days since last successful backup.
  - "Backup destination configured" boolean.
- Server has a `BACKUP_REQUIRED` env var, default `true` in appliance, default `false` in standalone:
  - If `true` and no successful backup in the last 7 days, server logs warnings every 6 hours and surfaces a banner in the admin UI.
  - If `true` and no successful backup in the last 30 days, server **refuses new vault uploads** until backup status is restored. Existing data remains accessible.
  - This is intentionally aggressive. Customers who lose their firm key after a month of unbacked vault uploads will not have a path to recovery. Better to fail loud while it's recoverable.

**Appliance integration.** The appliance's bootstrap flow for Connect requires the customer to confirm Duplicati backup destination is configured. The console's "Apps" panel for Connect shows a red banner — "Backup destination not configured. Configure backup before enabling Connect for production use." — until Duplicati reports a successful backup containing `vibe-connect-keys`.

**Tests.**

- Fresh install with no backup configured: Connect starts, banner appears, vault upload blocked after 30 days (test by faking timestamps).
- Backup configured and successful: banner clears, vault uploads work normally.
- Backup configured but failing: banner shows error with recovery hint.
- Restore test: simulate volume loss, restore from backup, confirm fingerprint match and vault data accessible.
- **Disaster recovery drill** (manual, but documented in INSTALL.md): customer is walked through a "delete the key volume, restore from backup, verify" exercise during initial setup. They have to do it once before the appliance considers them production-ready.

**Standalone impact.** Default `BACKUP_REQUIRED=false` for standalone. Customers who self-manage backups see no behavior change. The new admin endpoint is additive.

### 5.5 Email and SMS provider configuration

**Goal.** Magic-link emails and SSN/EIN step-up SMS messages send reliably. Provider abstraction lets customers swap providers without code changes.

**Action — email:**

- New env vars:
  - `EMAIL_PROVIDER` — `resend` | `postmark` | `smtp` | `none`. Default `none`.
  - `RESEND_API_KEY`, `POSTMARK_SERVER_TOKEN`, `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` — provider-specific.
  - `EMAIL_FROM` — From address for magic-link emails. Required if provider is set.
- Internal email interface: `sendEmail(to, subject, body, opts)`. App code never imports provider SDKs directly.
- If `EMAIL_PROVIDER=none`: client portal magic-link flow is **unavailable** — clients can't log in without email. Admin UI shows "Email not configured — client portal disabled" banner.

**Action — SMS:**

- Same envs as Payroll-Time §5.6. Default in appliance: `SMS_PROVIDER=textlink` (matching the BYOD-Android primary pattern from existing Connect deployments). Standalone default: `none`.
- TextLink config: `TEXTLINK_API_URL`, `TEXTLINK_API_KEY`.
- Twilio fallback: if `SMS_PROVIDER=twilio_with_textlink_fallback` is set, Twilio is primary and TextLink is fallback (or vice versa with `textlink_with_twilio_fallback`). Implementation: try primary, fall through to fallback on transient failure (5xx, timeout). Hard failures (auth, rate limit) don't fall through — they surface to the user.
- If both unavailable: SSN/EIN step-up flow disabled. Magic-link first-factor still works for clients but they can't complete the second factor. Document.

**Tests.**

- Each email provider: send a test magic-link email via admin UI, verify delivery.
- Each SMS provider: send a test SMS via admin UI, verify delivery.
- Provider misconfigured: error logged, request fails gracefully, customer sees actionable error in admin UI.
- Fallback test: simulate primary provider failure, verify fallback fires.
- `EMAIL_PROVIDER=none`: client portal explicitly disabled, banner visible.

**Standalone impact.** Existing customers with provider config see no change. New providers are additive.

### 5.6 Magic-link + SSN/EIN step-up flow

**Goal.** Client login flow works end-to-end with `PUBLIC_URL_CLIENT` correctly embedded in emails, and step-up SMS reaches the correct phone number.

**Action.** This is mostly an audit, with one design clarification:

- **Magic-link URL embedding.** Email body must use `${PUBLIC_URL_CLIENT}/auth/magic?token=...`. If `PUBLIC_URL_CLIENT` is unset, fall back to `${PUBLIC_URL}` for compatibility, then to the first `ALLOWED_ORIGIN` entry. Log a warning if either fallback is hit.
- **Step-up SMS.** Sends a one-time code to the phone number associated with the client account. Verify:
  - Phone number stored at client provisioning time (admin enters it when adding a client).
  - Code TTL is 5 minutes (configurable via `STEP_UP_CODE_TTL_SECONDS`).
  - Rate limit: 3 attempts per code, then a new code must be requested.
  - Failed attempts logged with client ID and IP.
- **Step-up over HTTP refused.** If the request to `/auth/step-up` arrives over HTTP (no TLS), server responds 400 with "Step-up authentication requires a secure connection." This prevents emergency-mode clients from completing step-up over plain HTTP, which would expose the SSN/EIN suffix.
- **Magic-link URL embedded in step-up failure email** to the client and admin: "Suspicious step-up attempt for your account from IP X.Y.Z.W. If this wasn't you, contact your firm immediately."

**Tests.**

- Happy path: admin provisions client, client receives magic-link email, clicks link, enters last 4 of SSN, gets logged in.
- Step-up over HTTP: same flow but accessing client portal at `:5182` emergency port. After clicking magic link, step-up page displays "Use the secure URL" message and refuses to accept SSN entry.
- Wrong SSN entered 3 times: code invalidated, client must request new magic link.
- Phone number not provisioned: step-up SMS fails, client gets "Contact your firm to complete login" message.

**Standalone impact.** None — same flow works in standalone with proper `PUBLIC_URL_CLIENT` setting.

### 5.7 `PUBLIC_URL` for staff and client subdomains

**Goal.** URLs embedded in emails, SMS, and exports use the customer-visible URL for the right audience.

**Action.**

- Two env vars instead of one:
  - `PUBLIC_URL_STAFF` — used in emails to staff members (password reset, mention notifications). Defaults to `https://connect.<domain>` in appliance, first `ALLOWED_ORIGIN` entry in standalone.
  - `PUBLIC_URL_CLIENT` — used in emails to clients (magic links, document request invitations). Defaults to `https://client.<domain>` in appliance.
- Manifest declares both via `publicUrlEnvVars`:

```json
"publicUrlEnvVars": {
  "staff":  "PUBLIC_URL_STAFF",
  "client": "PUBLIC_URL_CLIENT"
}
```

- Server selects which to use based on the audience of the recipient.

**Tests.**

- Generated magic link to a client contains `https://client.firm.com/auth/magic?...`.
- Generated mention notification to a staff member contains `https://connect.firm.com/thread/...`.
- Both URLs work when clicked.

**Standalone impact.** Existing customers with `PUBLIC_URL` set continue to work via the fallback chain.

### 5.8 Push notifications and service worker

**Goal.** Web Push works on primary and Tailscale; gracefully disabled on emergency mode; never silently broken.

**Action.**

- Service worker registers only over HTTPS. Browser handles this enforcement; app should not fight it.
- App detects HTTP origin and:
  - Hides the "Enable notifications" prompt in settings.
  - Shows a banner: "Push notifications require secure access. Use https://connect.firm.com or your Tailscale URL."
- VAPID keys (for Web Push) generated once at firm bootstrap and stored alongside the firm key in `vibe-connect-keys`. Same backup criticality.
- Native Tauri desktop wrapper uses OS notifications, no service worker needed; works on emergency mode (limitation: no notifications when desktop app isn't running, which is true for any access mode).

**Tests.**

- Open Connect on HTTPS, enable notifications, send a message from another account, confirm push received.
- Open Connect on HTTP emergency, settings hide notification toggle, banner visible.
- Tauri desktop on emergency URL: send message, confirm OS notification fires regardless of HTTP/HTTPS.

**Standalone impact.** None — same behavior across deployment modes.

### 5.9 Tauri desktop wrapper compatibility and distribution

**Goal.** The Tauri 2 desktop wrapper for Connect works against any of the three appliance access methods without modification, and customers can download the wrapper from their own Connect deployment without touching GitHub directly.

**Action — wrapper compatibility.** Mostly nothing — the desktop wrapper is just a Chromium-with-extras pointed at a configurable URL. The user enters their firm's Connect URL on first launch (e.g., `https://connect.firm.com` or `https://connect.<tailnet>.ts.net`), and the wrapper stores it locally.

**One thing to verify in the desktop wrapper code:**

- URL configuration accepts plain HTTP (for emergency-mode use). Reject by default (warn) with an "I understand this is insecure" override toggle. This protects against social-engineering attacks where someone tells a staff member "use http://malicious-server:5181" instead of the real emergency URL.

**Action — appliance-hosted download.** The staff web image (`vibe-connect-web`) hosts a `/desktop/` redirect that sends customers to the official Vibe-Connect releases page. This means a CPA on `https://connect.firm.com/desktop/` gets redirected to the signed Tauri binaries on GitHub — they don't have to know GitHub exists or hunt for the right URL.

Implementation is a single nginx config line in the `vibe-connect-web` image:

```nginx
location = /desktop/ {
  return 302 https://github.com/KisaesDevLab/Vibe-Connect/releases/latest;
}
```

The staff web SPA includes a "Download Desktop" link in the user dropdown menu pointing at `/desktop/`. The link is **only in the staff web image, not the client portal image** — clients have no use for the desktop wrapper, and surfacing a download link there would be confusing.

For appliance deployments, the redirect URL can be overridden via env var `DESKTOP_DOWNLOAD_URL` if you ever move releases away from GitHub. Default is the GitHub releases page above. Standalone customers running the same image get the same redirect; works identically in both modes.

**Out of scope:**

- Tauri auto-update mechanism (separate from appliance update flow).
- Code signing for Windows / macOS desktop binaries.
- A custom-branded download page (v1 sends customers to GitHub's release UI; v1.1 could host a polished download page if customer feedback demands it).
- Per-platform automatic detection on the download page (GitHub's release page handles this acceptably for v1).

**Tests.**

- Desktop wrapper points at primary URL, works.
- Desktop wrapper points at Tailscale URL, works.
- Desktop wrapper points at emergency URL with explicit override, works (with insecure-connection warning shown in the wrapper's chrome).
- Visit `https://connect.firm.com/desktop/` in a browser → 302 redirect to GitHub releases page.
- Visit `https://client.firm.com/desktop/` (client portal) → 404. The download path is staff-only.
- Override: set `DESKTOP_DOWNLOAD_URL=https://example.com/foo`, redeploy, confirm `/desktop/` redirects there instead.

**Standalone impact.** None — desktop wrapper is independent of how Connect is deployed, and the `/desktop/` redirect works the same way in standalone.

### 5.10 `docker-compose.appliance.yml`

The most complex of the Vibe app overlays. Three services + dependencies on shared infra.

```yaml
# docker-compose.appliance.yml
# Appliance overlay for Vibe-Connect. Used by Vibe-Appliance.
# Standalone deployments should use docker-compose.yml instead.

services:
  vibe-connect-server:
    image: ghcr.io/kisaesdevlab/vibe-connect-server:${VIBE_CONNECT_TAG:-latest}
    networks: [vibe_net]
    environment:
      DATABASE_URL: ${VIBE_CONNECT_DATABASE_URL}
      REDIS_URL: ${VIBE_CONNECT_REDIS_URL}
      ALLOWED_ORIGIN: ${VIBE_CONNECT_ALLOWED_ORIGIN}
      PUBLIC_URL_STAFF: ${VIBE_CONNECT_PUBLIC_URL_STAFF}
      PUBLIC_URL_CLIENT: ${VIBE_CONNECT_PUBLIC_URL_CLIENT}
      JWT_SECRET: ${VIBE_CONNECT_JWT_SECRET}
      ENCRYPTION_KEY: ${VIBE_CONNECT_ENCRYPTION_KEY}
      MIGRATIONS_AUTO: "false"
      LOG_LEVEL: ${VIBE_CONNECT_LOG_LEVEL:-info}
      EMAIL_PROVIDER: ${VIBE_CONNECT_EMAIL_PROVIDER:-none}
      EMAIL_FROM: ${VIBE_CONNECT_EMAIL_FROM:-}
      RESEND_API_KEY: ${VIBE_CONNECT_RESEND_API_KEY:-}
      POSTMARK_SERVER_TOKEN: ${VIBE_CONNECT_POSTMARK_SERVER_TOKEN:-}
      SMTP_HOST: ${VIBE_CONNECT_SMTP_HOST:-}
      SMTP_PORT: ${VIBE_CONNECT_SMTP_PORT:-}
      SMTP_USER: ${VIBE_CONNECT_SMTP_USER:-}
      SMTP_PASS: ${VIBE_CONNECT_SMTP_PASS:-}
      SMS_PROVIDER: ${VIBE_CONNECT_SMS_PROVIDER:-textlink}
      TEXTLINK_API_URL: ${VIBE_CONNECT_TEXTLINK_API_URL:-}
      TEXTLINK_API_KEY: ${VIBE_CONNECT_TEXTLINK_API_KEY:-}
      TWILIO_ACCOUNT_SID: ${VIBE_CONNECT_TWILIO_ACCOUNT_SID:-}
      TWILIO_AUTH_TOKEN: ${VIBE_CONNECT_TWILIO_AUTH_TOKEN:-}
      TWILIO_FROM_NUMBER: ${VIBE_CONNECT_TWILIO_FROM_NUMBER:-}
      BACKUP_REQUIRED: "true"
      STEP_UP_CODE_TTL_SECONDS: "300"
    volumes:
      - vibe-connect-keys:/app/data/keys
      - vibe-connect-vault:/app/data/vault
      - vibe-connect-uploads:/app/data/uploads
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:4000/api/v1/ping"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s

  vibe-connect-worker:
    image: ghcr.io/kisaesdevlab/vibe-connect-server:${VIBE_CONNECT_TAG:-latest}
    command: ["node", "dist/worker.js"]
    networks: [vibe_net]
    environment:
      DATABASE_URL: ${VIBE_CONNECT_DATABASE_URL}
      REDIS_URL: ${VIBE_CONNECT_REDIS_URL}
      WORKER_CONCURRENCY: "4"
      LOG_LEVEL: ${VIBE_CONNECT_LOG_LEVEL:-info}
      EMAIL_PROVIDER: ${VIBE_CONNECT_EMAIL_PROVIDER:-none}
      RESEND_API_KEY: ${VIBE_CONNECT_RESEND_API_KEY:-}
      POSTMARK_SERVER_TOKEN: ${VIBE_CONNECT_POSTMARK_SERVER_TOKEN:-}
      SMTP_HOST: ${VIBE_CONNECT_SMTP_HOST:-}
      SMTP_PORT: ${VIBE_CONNECT_SMTP_PORT:-}
      SMTP_USER: ${VIBE_CONNECT_SMTP_USER:-}
      SMTP_PASS: ${VIBE_CONNECT_SMTP_PASS:-}
      SMS_PROVIDER: ${VIBE_CONNECT_SMS_PROVIDER:-textlink}
      TEXTLINK_API_URL: ${VIBE_CONNECT_TEXTLINK_API_URL:-}
      TEXTLINK_API_KEY: ${VIBE_CONNECT_TEXTLINK_API_KEY:-}
      TWILIO_ACCOUNT_SID: ${VIBE_CONNECT_TWILIO_ACCOUNT_SID:-}
      TWILIO_AUTH_TOKEN: ${VIBE_CONNECT_TWILIO_AUTH_TOKEN:-}
    restart: unless-stopped
    depends_on: [vibe-connect-server]

  vibe-connect-web:
    image: ghcr.io/kisaesdevlab/vibe-connect-web:${VIBE_CONNECT_TAG:-latest}
    networks: [vibe_net]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:80/"]
      interval: 30s
      timeout: 5s
      retries: 3
    depends_on: [vibe-connect-server]

  vibe-connect-portal:
    image: ghcr.io/kisaesdevlab/vibe-connect-portal:${VIBE_CONNECT_TAG:-latest}
    networks: [vibe_net]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:80/"]
      interval: 30s
      timeout: 5s
      retries: 3
    depends_on: [vibe-connect-server]

networks:
  vibe_net:
    external: true

volumes:
  vibe-connect-keys:
  vibe-connect-vault:
  vibe-connect-uploads:
```

Notes:

- Four containers: server, worker, web, portal. Worker uses the server image with a different command.
- Three volumes: keys (sacred — see §5.4), vault (encrypted client files), uploads (raw uploads being processed).
- Worker doesn't expose health; depends on server.
- All four containers on `vibe_net`; only Caddy and HAProxy publish ports.
- `vibe-connect-portal` and `vibe-connect-web` are separate images (different build targets, different SPAs) — verify GHCR publishes both.

### 5.11 `.appliance/manifest.json`

```json
{
  "schemaVersion": 1,
  "slug": "vibe-connect",
  "displayName": "Vibe Connect",
  "description": "End-to-end encrypted messaging and document sharing for CPA firms and their clients",
  "logo": "connect.svg",
  "userFacing": true,
  "image": {
    "server": "ghcr.io/kisaesdevlab/vibe-connect-server",
    "web":    "ghcr.io/kisaesdevlab/vibe-connect-web",
    "portal": "ghcr.io/kisaesdevlab/vibe-connect-portal",
    "defaultTag": "latest"
  },
  "ports": { "server": 4000, "web": 80, "portal": 80 },
  "subdomains": [
    {
      "name": "connect",
      "target": "vibe-connect-web:80",
      "audience": "staff",
      "emergencyPort": 5181
    },
    {
      "name": "client",
      "target": "vibe-connect-portal:80",
      "audience": "client",
      "emergencyPort": 5182,
      "emergencyNote": "Staff debugging only. Clients reach the portal via primary URL only — magic-link emails embed primary URLs and step-up auth refuses HTTP."
    }
  ],
  "depends": ["postgres", "redis"],
  "publicUrlEnvVars": {
    "staff": "PUBLIC_URL_STAFF",
    "client": "PUBLIC_URL_CLIENT"
  },
  "websocket": true,
  "env": {
    "required": [
      { "name": "JWT_SECRET", "generate": "hex32" },
      { "name": "ENCRYPTION_KEY", "generate": "hex32" },
      { "name": "DATABASE_URL", "from": "shared-postgres-url", "database": "vibe_connect_db", "user": "vibeconnect" },
      { "name": "REDIS_URL", "from": "shared-redis-url", "namespace": "connect" },
      { "name": "ALLOWED_ORIGIN", "from": "subdomain-urls" },
      { "name": "PUBLIC_URL_STAFF", "from": "subdomain-url", "subdomain": "connect" },
      { "name": "PUBLIC_URL_CLIENT", "from": "subdomain-url", "subdomain": "client" }
    ],
    "optional": [
      { "name": "EMAIL_PROVIDER", "default": "none", "doc": "resend | postmark | smtp | none. Client portal disabled when none." },
      { "name": "EMAIL_FROM", "doc": "Required if EMAIL_PROVIDER is set" },
      { "name": "RESEND_API_KEY", "secret": true },
      { "name": "POSTMARK_SERVER_TOKEN", "secret": true },
      { "name": "SMTP_HOST" },
      { "name": "SMTP_PORT" },
      { "name": "SMTP_USER", "secret": true },
      { "name": "SMTP_PASS", "secret": true },
      { "name": "SMS_PROVIDER", "default": "textlink", "doc": "textlink | twilio | textlink_with_twilio_fallback | twilio_with_textlink_fallback | none" },
      { "name": "TEXTLINK_API_URL" },
      { "name": "TEXTLINK_API_KEY", "secret": true },
      { "name": "TWILIO_ACCOUNT_SID", "secret": true },
      { "name": "TWILIO_AUTH_TOKEN", "secret": true },
      { "name": "TWILIO_FROM_NUMBER" },
      { "name": "WORKER_CONCURRENCY", "default": "4" },
      { "name": "LOG_LEVEL", "default": "info" },
      { "name": "BACKUP_REQUIRED", "default": "true" }
    ]
  },
  "database": { "name": "vibe_connect_db", "user": "vibeconnect" },
  "firstLogin": {
    "type": "self-register-first-user-becomes-admin",
    "url": "/register",
    "note": "First registered user at connect.<domain> becomes the firm admin. Send the URL to the firm partner who will manage user provisioning."
  },
  "health": "/api/v1/health",
  "ping": "/api/v1/ping",
  "migrations": {
    "command": ["node", "dist/migrate.js"],
    "autoEnvVar": "MIGRATIONS_AUTO"
  },
  "backup": {
    "volumes": ["vibe-connect-keys", "vibe-connect-vault", "vibe-connect-uploads"],
    "databases": ["vibe_connect_db"],
    "criticalVolumes": ["vibe-connect-keys"],
    "backupVerification": {
      "required": true,
      "blockOnFailureAfterDays": 30,
      "warnAfterDays": 7
    }
  },
  "desktopDistribution": {
    "enabled": true,
    "downloadPath": "/desktop/",
    "audience": "staff",
    "defaultRedirect": "https://github.com/KisaesDevLab/Vibe-Connect/releases/latest",
    "envOverride": "DESKTOP_DOWNLOAD_URL"
  }
}
```

The `backup.criticalVolumes` and `backup.backupVerification` blocks are Connect-specific manifest extensions that the appliance console and Duplicati integration honor. **No other Vibe app declares `criticalVolumes`** — Connect is unique in having data that is unrecoverable on key loss.

### 5.12 Volume strategy

- `vibe-connect-keys` — firm E2EE key, VAPID push keys, future signing keys. Tiny (kilobytes). Backed up always; restoration verified.
- `vibe-connect-vault` — encrypted client vault file storage. Can be large; growth rate scales with client usage.
- `vibe-connect-uploads` — raw uploads being processed (encryption + thumbnail generation in workers). Cleaned to vault after processing; should be small at rest.

Standalone uses bundled volumes; appliance maps under `/opt/vibe/data/apps/vibe-connect/` for Duplicati visibility.

App code must not write non-ephemeral data outside these volumes.

### 5.13 Emergency-access compatibility

**Goal.** Staff emergency port `:5181` works for staff messaging during a Caddy outage. Client emergency port `:5182` is staff-debugging-only and has explicit guards against unsafe use.

**Action — same five items as MyBooks plus three Connect-specific:**

1. **Disable HTTPS-redirect inside the app.** Audit middleware. Same as other apps.
2. **No `X-Forwarded-Proto: https` requirement.** Same as other apps.
3. **Host header allowlist tolerates IP:port form.** Same as other apps.
4. **Cookies use `secure: 'auto'` AND host-only Domain on emergency.** Same as other apps for the Secure flag; plus the no-Domain cookie behavior on emergency ports is the correct default and shouldn't need overriding.
5. **`/api/v1/ping` works without DB or Redis.** Already covered by §5.4.

**Connect-specific:**

6. **Step-up auth refuses HTTP.** When the request to `/auth/step-up` arrives without TLS context, server returns 400 with explanatory message. Already covered by §5.6.
7. **Push notification setup hidden on HTTP.** Already covered by §5.8.
8. **Client portal at emergency port shows staff-only banner.** When `vibe-connect-portal` detects HTTP origin, it displays a top banner: "EMERGENCY ACCESS — Staff debugging only. Clients should use https://client.firm.com." This banner shows even on the login page so staff doing debugging see the warning before authenticating.

**Tests.**

- Kill Caddy, hit `http://<lan-ip>:5181/`. Staff log in with valid credentials, send a message, confirm WebSocket delivery to a second tab on the same emergency URL. Works.
- Hit `http://<lan-ip>:5182/`. Banner visible at top. Login page rendered.
- Try magic-link flow at `:5182`: enter email, magic link sent (assuming email provider configured), but step-up phase rejects with "Use the secure URL" message.
- Cookie inspection on emergency URLs: session cookies have no `Domain` attribute (host-only), `Secure` flag absent.
- WebSocket test: Socket.io connection over `ws://<lan-ip>:5181/socket.io/...` succeeds.

**Standalone impact.** Items 1, 2, and 4 are improvements that benefit any standalone running plain HTTP behind an external proxy. Items 3, 5, 6, 7, 8 are no-ops in standalone HTTPS mode.

---

## 6. PR plan

**Four PRs** against `KisaesDevLab/Vibe-Connect`, in order. Connect's complexity earns one more PR than the others. **PR 0 is the license blocker — it must merge first or none of the others matter.**

### PR 0: License change (BLOCKER)

- Replace README "Proprietary" wording.
- Add `LICENSE` file with ELv2 text.
- One file plus one README edit. Reviewable in 5 minutes.

**Open this immediately. Do not wait on any other work.**

### PR 1: Common-requirements + emergency compat (sections 3, 5.13)

The mechanical changes that don't touch security-sensitive paths.

- Multi-arch GHCR publishing audit (server, web, portal images).
- `DATABASE_URL` / `REDIS_URL` consolidation.
- `ALLOWED_ORIGIN` list with regex.
- `MIGRATIONS_AUTO` env var.
- `/health` and `/ping` endpoints.
- BullMQ workers env-driven with heartbeats.
- Structured stdout logging.
- Emergency-access compatibility items 1–5 (HTTPS-redirect removal, `X-Forwarded-Proto` gating, cookie `secure: 'auto'`, host header tolerance, ping without deps).

### PR 2: Multi-subdomain + WebSockets + cookies + step-up + push (sections 5.1, 5.2, 5.3, 5.6, 5.8, 5.13 items 6-8)

The security-sensitive PR. Higher review weight; pair with Kurt directly.

- Multi-subdomain audience routing in server.
- Audience-mismatch 403 enforcement.
- Cookie domain scoping audit and fix.
- WebSocket transparency through Caddy and HAProxy.
- Step-up auth refuses HTTP.
- Push notifications hidden on HTTP, banner on emergency client portal.
- Magic-link URL embedding via `PUBLIC_URL_*`.

### PR 3: Email/SMS providers + firm key backup verification (sections 5.4, 5.5, 5.7)

The provider-config + backup-criticality PR.

- Email provider abstraction (Resend / Postmark / SMTP / none).
- SMS provider abstraction with TextLink default and Twilio fallback.
- `PUBLIC_URL_STAFF` and `PUBLIC_URL_CLIENT` plumbing.
- Firm key fingerprint verification on startup.
- `BACKUP_REQUIRED` enforcement with grace period.
- Admin endpoint `/api/v1/admin/key-status`.
- Admin UI banner for backup status.

### PR 4: Appliance overlay + manifest + Tauri compat + desktop distribution (sections 5.9, 5.10, 5.11, 5.12)

The "make it appliance-ready" PR. No app code changes — all configuration, metadata, and a single nginx redirect.

- Adds `docker-compose.appliance.yml`.
- Adds `.appliance/manifest.json` with multi-subdomain, emergency ports, backup-verification metadata, and `desktopDistribution` config.
- Updates `README.md` with deployment guide.
- Adds `/desktop/` nginx redirect rule in the `vibe-connect-web` image (NOT the portal image).
- Adds "Download Desktop" link in the staff web SPA's user dropdown menu pointing at `/desktop/`.
- Adds `DESKTOP_DOWNLOAD_URL` env var with default to GitHub releases URL.
- Tauri desktop wrapper insecure-URL warning.
- Volume strategy documentation.

After PR 4 merges and a tagged image publishes, the Vibe-Appliance Phase 5 work for Vibe-Connect becomes:

1. Drop `apps/vibe-connect.yml` overlay in the appliance repo.
2. Drop `env-templates/per-app/vibe-connect.env.tmpl`.
3. Implement the appliance console's "Backup destination required" gate for Connect.
4. Implement the disaster-recovery drill flow during appliance bootstrap when Connect is enabled.
5. Test toggle on/off, all three access methods, magic-link flow, step-up flow on a fresh droplet.

---

## 7. Backward compatibility commitments

Things that must not change for existing standalone customers:

- Existing standalone install path produces a working install on a fresh Ubuntu host with no env-var changes required.
- An existing customer's `.env` file continues to work after upgrade. Deprecated vars produce a single `[deprecated]` log line and synthesize the new vars internally.
- Default `BACKUP_REQUIRED=false` for standalone. Existing customers who self-manage backups see no behavior change.
- Existing TextLink and Twilio configurations work unchanged.
- Existing Tauri desktop wrappers continue to connect to existing Connect deployments.
- Database schema and data unaffected by these changes.
- Existing single-subdomain deploys (staff-only) continue to work; the portal container can be omitted via compose profile.

If anything in section 5 violates these, that section is wrong and needs revision.

---

## 8. Out of scope

Things deliberately **not** in this addendum:

- **SSO with other Vibe apps.** Each app keeps its own auth.
- **Multi-firm Connect deployments.** Single firm per appliance.
- **End-to-end voice or video.** Out of scope for v1.
- **Federated Connect deployments** (multiple firms communicating between Connect instances). Out of scope.
- **Mobile native apps.** PWA + Tauri desktop only for v1.
- **Tauri desktop auto-updater integration** with appliance version. Tauri updates independently.
- **Key rotation flow.** Adding a "rotate firm key" admin button is a v1.1 feature; v1 has the schema support but no UI.
- **Compliance attestations** (SOC 2, HIPAA, etc.). Out of scope; document the controls we have, leave attestations to v1.x.

---

## 9. Definition of done

This addendum is complete when:

1. **PR 0 (license) is merged.** Without this, nothing else ships.
2. PRs 1, 2, 3, 4 are merged in order.
3. New image tags published to GHCR for all three image families (server, web, portal) with both architectures.
4. Standalone install on a fresh Ubuntu 24.04 droplet via the existing flow produces a working app — same behavior as before this work.
5. Appliance integration test: parent appliance compose with this app's overlay brings up Vibe-Connect at `connect.<test-domain>` (staff) and `client.<test-domain>` (client portal).
6. Staff first-login flow works at `connect.<test-domain>`. First-registered user becomes firm admin.
7. Client provisioning flow: admin adds a client (with phone number for step-up); client receives magic-link email at provided address; client clicks link, completes SSN/EIN step-up, lands in client portal at `client.<test-domain>`.
8. Staff and client send messages to each other; messages arrive in real-time via Socket.io WebSocket.
9. Tailscale access test: staff can use Connect at `connect.<test-tailnet>.ts.net` including WebSockets and message delivery.
10. **Emergency access tests:**
    a. With Caddy stopped, staff can log in at `http://<lan-ip>:5181`, send messages, receive messages over WebSocket. Banner about emergency mode visible.
    b. Client portal at `http://<lan-ip>:5182` shows staff-only banner. Login page renders. Step-up auth refuses with explanatory message if attempted.
11. **Backup criticality tests:**
    a. Fresh install: backup status banner visible until Duplicati reports a successful backup containing `vibe-connect-keys`.
    b. Disaster recovery drill: simulate volume loss, restore from backup, verify firm key fingerprint matches DB record, confirm vault data accessible.
12. Cookie scoping test: staff cookies don't leak to client portal subdomain and vice versa, on both primary and emergency.
13. The seven backward-compat commitments in §7 hold under regression testing.

When that's true, the appliance Phase 5 (Vibe-Connect integration) reduces to the five-step task at the end of §6.

**Connect is the most architecturally complex Vibe app to integrate.** Budget accordingly. The four PRs and the integration work add up to ~1.5 weeks of focused work, plus the disaster-recovery drill design which is genuinely a new piece of customer-facing UX.
