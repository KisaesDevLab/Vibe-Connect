# Vibe Connect Desktop (Tauri shell)

Operator + developer reference for the Windows / macOS / Linux desktop
shell. The shell is a thin wrapper: it ships a single onboarding HTML page
that asks for the firm's appliance URL, and after that it loads the
appliance's web app directly into a native window.

## Architecture

```
┌─ apps/desktop ────────────────────────────────────────────────────────┐
│                                                                       │
│   onboarding/             ← built to apps/desktop/dist/                │
│     index.html            ← the only page the shell ships              │
│     main.ts               ← form wiring + IPC calls                    │
│     styles.css                                                         │
│     lib/                                                               │
│       url.ts              ← pure helpers (vitest-able)                 │
│       tauri.ts            ← thin __TAURI__ wrapper + dev fallback      │
│     __tests__/                                                         │
│                                                                       │
│   src-tauri/                                                          │
│     src/main.rs           ← Rust shell + IPC commands                 │
│     tauri.conf.json       ← frontendDist → ../dist                    │
│     capabilities/                                                     │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

The Rust shell exposes five IPC commands:

| Command                  | Args         | Returns           | Used by                     |
| ------------------------ | ------------ | ----------------- | --------------------------- |
| `get_appliance_url`      | —            | `Option<String>`  | onboarding boot, dev tools  |
| `set_appliance_url`      | `{ url }`    | `String`          | onboarding submit handler   |
| `clear_appliance_url`    | —            | `()`              | tray "Change server…"       |
| `navigate_to_appliance`  | —            | `()`              | onboarding submit handler   |
| `get_desktop_version`    | —            | `String`          | onboarding footer           |

The appliance URL lives in `tauri-plugin-store`'s `settings.json`, which
on Windows resolves to:

```
%APPDATA%\app.vibeconnect.desktop\settings.json
```

On macOS: `~/Library/Application Support/app.vibeconnect.desktop/settings.json`
On Linux: `~/.config/app.vibeconnect.desktop/settings.json`

## First-run flow

1. User installs and launches Vibe Connect.
2. The Rust shell creates the main window with `frontendDist` pointing at
   `../dist` — i.e. `apps/desktop/dist/index.html` (the onboarding bundle).
3. `setup()` checks `tauri-plugin-store` for `appliance_url`. Empty on
   first run, so onboarding stays on screen.
4. User types `https://connect.smithcpa.com` (or just `connect.smithcpa.com`).
5. JS validates the input (`normalizeApplianceUrl`) — strips trailing slashes,
   defaults to `https://`, rejects non-http(s), rejects query strings and
   fragments, refuses plain HTTP unless the developer override checkbox is on.
   A path component IS allowed so multi-app appliances at
   `https://shared.host/connect` work without special handling.
6. JS fetches `${url}/__vibe-boot.js` with a 10s timeout. The body is run
   through `validateBootScript` which confirms the assignment marker and
   parses out `basePath` / `tlsMode` / `appName` / `buildVersion`.
7. On success, JS calls `set_appliance_url(url)` → Rust persists. Then
   `navigate_to_appliance()` → Rust navigates the webview directly to the
   appliance.
8. The appliance's normal web app loads (full E2EE crypto, IndexedDB, etc.).

## Subsequent launches

The Rust `setup()` hook reads `appliance_url`. When present, it navigates
the main window to that URL immediately — the bundled onboarding flashes
on screen for one frame at most before being replaced. From the user's
perspective it feels like a regular Slack-style desktop app.

## Switching servers

Right-click the tray icon → "Change server…". The Rust shell:

1. Deletes `appliance_url` from the store (`store.delete` + `store.save`).
2. Navigates the webview back to the bundled onboarding URL captured at
   startup (`OnboardingUrl(Mutex<Option<Url>>)`).
3. The user sees the onboarding form again.

**Important — switching servers is a hard reset.** IndexedDB is scoped to
the appliance origin, so the wrapped device key, the search index, and
any cached message state stay locked to the old appliance. The user must
sign in again on the new one and may need to re-enroll the device.

## Build commands

| Command                            | Effect                                              |
| ---------------------------------- | --------------------------------------------------- |
| `yarn workspace @vibe-connect/desktop dev`        | Vite serves the onboarding at :5180 (no Tauri)    |
| `yarn workspace @vibe-connect/desktop build`      | Vite builds onboarding to `apps/desktop/dist/`    |
| `yarn workspace @vibe-connect/desktop tauri:dev`  | Tauri dev: Rust + Vite + webview live-reload      |
| `yarn workspace @vibe-connect/desktop tauri:build`| Production .msi / .nsis / .dmg / .AppImage / .deb |

The `beforeBuildCommand` in `tauri.conf.json` runs `yarn build` first,
so a cold `tauri:build` produces a self-contained installer in one step.

## Cargo dependencies that matter

```
url = "2"   # appliance URL guards in main.rs
tauri-plugin-store = "2.0"   # appliance_url persistence
```

Tauri 2.x re-exports `url::Url` as `tauri::Url`, but the Cargo dep is
pinned directly so an internal Tauri rename can't break us silently.

## CSP

Two CSPs apply to the onboarding bundle:

1. The `app.security.csp` in `tauri.conf.json` — covers the bundled
   onboarding page when served from Tauri's internal scheme.
2. The `<meta http-equiv="Content-Security-Policy">` in
   `onboarding/index.html` — narrower set for the onboarding fetch.

Both intentionally allow `connect-src https: http:` because the entire
point of the form is to let the user pick any appliance. Once the webview
navigates away to `https://connect.smithcpa.com`, the appliance's own
CSP applies (set by the server's helmet middleware) and the onboarding
CSP is irrelevant.

The CSP does NOT use `unsafe-inline` for scripts. The HTML loads `main.ts`
via `<script type="module" src>` and Vite hashes it during the build.

## Manual test checklist (Windows release)

Run through this on a fresh Windows VM before tagging a release. Each box
should pass exactly once per test cycle.

### Fresh install

- [ ] `vibe-connect_*.msi` installs without prompting for elevation
      (per-user NSIS install).
- [ ] First launch shows the onboarding card with the URL field focused.
- [ ] Footer shows the correct version string (matches Cargo.toml).
- [ ] Tray icon appears in the notification area.

### URL validation

- [ ] Empty submit → "Enter your firm's Vibe Connect URL."
- [ ] `not a url` → "That URL doesn't look right…"
- [ ] `ftp://example.com` → "Only http(s) is supported…"
- [ ] `http://connect.example.com` (with checkbox OFF) → HTTPS-required error.
- [ ] `https://shared.host/connect` (multi-app deployment) → accepted; the
      probe fetches `/connect/__vibe-boot.js` and the appliance loads at
      `/connect/`.
- [ ] `https://connect.example.com?foo=bar` → query rejected.
- [ ] `https://connect.example.com#anchor` → fragment rejected.

### Probe — happy path

- [ ] Typing the real appliance URL connects, shows "Connected to
      <appName>", then loads the appliance.
- [ ] The login form renders inside the desktop window with no scrollbars
      or visible flicker beyond the navigation flash.
- [ ] Login succeeds. The session cookie persists across desktop restarts
      (close window, click tray, reopen — still logged in).

### Probe — error paths

- [ ] Typing a domain that doesn't exist (DNS miss) → "Couldn't reach
      that server…" and the form re-enables.
- [ ] Typing a domain that returns HTML at `/__vibe-boot.js` (e.g. the
      apex of a marketing site) → "That server didn't identify itself
      as Vibe Connect."
- [ ] Typing a domain with an invalid TLS cert → fetch fails, error UX
      mentions the certificate.
- [ ] Pulling the network during the probe → "took too long to respond"
      after the 10s timeout (no UI hang).

### Persistence

- [ ] Quit the app via tray → "Quit". Relaunch. Should land in the
      appliance's signed-in state without showing the onboarding.
- [ ] Right-click tray → "Change server…". Onboarding reappears.
      Stored `appliance_url` is cleared from
      `%APPDATA%\app.vibeconnect.desktop\settings.json` (verify by
      opening the file).

### System integration

- [ ] Closing the window minimizes to tray (does NOT quit).
- [ ] Tray left-click toggles the window.
- [ ] `Ctrl+Shift+V` global shortcut toggles the window from any focused
      application.
- [ ] Desktop notifications work (test by sending a message from another
      session and watching for a Windows toast).

### Updater (optional, requires release infra)

- [ ] App detects a newer version on
      `kisaesdevlab.github.io/Vibe-Connect/{target}/{arch}/{current_version}/latest.json`
      and shows the updater dialog.

## First-install on Windows (SmartScreen)

The v1 MSI/NSIS bundles are **not** signed with a Microsoft-trusted
code-signing certificate. SmartScreen will block the first-install with
a full-screen blue dialog ("Windows protected your PC"). This is
expected and will go away once we ship a Phase B follow-on with an EV
cert (see "Code signing rollout" below).

Tell customers to:

1. Click **More info**.
2. Click **Run anyway**.
3. The installer launches normally. The warning does NOT reappear after
   the first install.

**Why we ship unsigned for v1.** SmartScreen reputation accrues with
total verified downloads of a signed binary. We could buy a regular OV
cert and wait weeks for reputation to build (during which every customer
hits the warning anyway), or buy an EV cert (~$300/yr) and skip
reputation entirely. v1 is a small audience of pilot CPA firms who can
absorb the warning; v1.x ships with EV-signed binaries to the broader
market.

If a customer's IT policy forbids running unsigned binaries, they must
either delay rollout to v1.1 OR install the desktop wrapper from inside
a Group Policy unblocking exception. There is no in-product workaround.

## Updater signing key rotation

The Tauri auto-updater verifies a `latest.json` payload against an
ed25519 public key embedded in `apps/desktop/src-tauri/tauri.conf.json`.
Each release's `latest.json` is signed with the matching private key
held in the GitHub Actions secret `TAURI_UPDATER_PRIVATE_KEY` (and
`TAURI_UPDATER_PRIVATE_KEY_PASSWORD` if the keypair was generated with a
password).

### Generating the keypair (first time)

```sh
# Run on a trusted dev machine — the private key never leaves it.
npx --yes @tauri-apps/cli@^2 signer generate -w apps/desktop/.tauri/signing.key
```

This emits two files:

- `apps/desktop/.tauri/signing.key` — private key. **Add to `.gitignore`
  immediately if not already.** Copy contents to GitHub repo settings →
  Secrets and variables → Actions → New repository secret →
  `TAURI_UPDATER_PRIVATE_KEY`.
- `apps/desktop/.tauri/signing.key.pub` — public key. Paste this string
  (the entire base64 blob) into `tauri.conf.json` as
  `plugins.updater.pubkey`. Commit.

After generating, **delete `apps/desktop/.tauri/signing.key` from disk**.
The GitHub secret is the only durable copy.

### Rotating the keypair

You only need to rotate if the private key is suspected leaked or after
a compromised dev machine. Updater rotation is a hard cliff: once a new
`pubkey` ships in the desktop app, only updates signed by the new
private key are accepted. Old installs that haven't yet pulled the
build with the new pubkey will lose the ability to auto-update — they
must reinstall manually.

Procedure:

1. Generate a new keypair as above.
2. Build a new release (e.g. `v1.1.5`) embedding the new pubkey. CI
   signs the `latest.json` with the new private key.
3. Push the new release. Customers on `v1.1.4` won't auto-update to
   `v1.1.5` because the signature is verified against the OLD pubkey
   they have. They must download the new MSI manually from
   `https://<appliance>/desktop/`.
4. Rotate the GitHub secret to the new private key (delete the old
   secret value).

Plan rotations during a customer-facing maintenance window — a "manual
reinstall" instruction is unavoidable.

### Verifying the published manifest

After a release tag pushes:

```sh
curl -s https://kisaesdevlab.github.io/Vibe-Connect/windows/x86_64/latest/latest.json | jq .
```

The `signature` field is the base64-encoded ed25519 signature over the
bundle download URL. Tauri verifies it against the embedded `pubkey`
when the user clicks "Update."

## Code signing rollout (deferred)

| Phase | Trigger | Effort |
| --- | --- | --- |
| v1 (now) | Pilot CPA firms accept SmartScreen warning | $0 |
| v1.x | Open beta, > ~20 firms | EV cert procurement (~$300/yr, 5-10 business days) + CI integration (1 PR) |
| v1.x+1 | Public release | Drop SmartScreen workaround from this doc |

Owner: Kurt. Track in `docs/ops/FEEDBACK_TRACKER.md` once a customer
hits the SmartScreen wall.

## Troubleshooting

**"Couldn't reach that server" but the URL is correct.**
The most common cause on Windows is the appliance using a self-signed or
internal-CA certificate that WebView2 doesn't trust. Add the CA to the
Windows trust store (`certmgr.msc` → "Trusted Root Certification
Authorities"). Verify by opening the URL in Edge first.

**App opens to a blank window with no onboarding.**
The bundled `dist/` directory wasn't built. Run
`yarn workspace @vibe-connect/desktop build` and re-run the Tauri build.
The `beforeBuildCommand` should do this automatically, but a manual
`tauri:build` invocation that skips it will produce a broken installer.

**"settings.json" location not found.**
Tauri creates it lazily on first write. If `set_appliance_url` has never
run, the file doesn't exist yet. Submit the onboarding form once, then
the file appears.

**The user wants to wipe everything (e.g. troubleshooting a corrupted
device record).**
Tray "Change server…" only clears the appliance URL. To also wipe
IndexedDB / cookies for a specific appliance, the user must use the
appliance's own "Sign out and forget device" option from the staff app's
profile menu. The desktop wrapper has no privileged data of its own
beyond the URL.
