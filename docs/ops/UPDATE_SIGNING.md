# Tauri updater signing — operational procedure

The desktop app ships signed update bundles verified by an Ed25519 keypair. **Losing the
private key means you cannot ship updates; leaking it means anyone else can push malicious
updates that run as Vibe Connect on every workstation.** Treat it like the firm recovery
phrase from Phase 3.

## Key generation (do this ONCE, offline)

```bash
# On an air-gapped workstation:
cargo tauri signer generate -w vibe-connect-update.key
# → prints the public key + writes vibe-connect-update.key (private)
```

## Storage

- Split the private key between two partners (paper copies, two separate safes).
- Keep an encrypted copy on an offline USB in a third safe.
- Record the public key in `apps/desktop/src-tauri/tauri.conf.json` under
  `plugins.updater.pubkey`. The public key is baked into every installed binary — changing
  it requires a reinstall notice to customers.

## Signing a release

```bash
# On the release workstation:
TAURI_SIGNING_PRIVATE_KEY="$(cat /path/to/vibe-connect-update.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<passphrase-if-set>" \
cargo tauri build
# Produces the installer binaries in src-tauri/target/release/bundle/
# plus the signed update manifest (`.sig` files).
```

Upload the bundled installers + `latest.json` to your release CDN (GitHub Releases works).
The updater endpoint in `tauri.conf.json` must return `latest.json` with URLs and signatures.

## Rotation

1. Generate a new keypair (see above).
2. Sign the NEXT release with BOTH keys (old + new) so in-flight installs can accept either.
3. Publish the new public key in an updated binary and in `docs/ops/UPDATE_SIGNING.md`.
4. Notify users that a one-time reinstall is required for the transition release.
5. Retire the old key after 30 days.

## Code signing (Authenticode / Apple notarization)

- **Windows**: EV certificate ($300–$600/yr); set `certificateThumbprint` in
  `tauri.conf.json` and sign the installer with `signtool`.
- **macOS**: Apple Developer ID ($99/yr); set `signingIdentity` and notarize via
  `xcrun notarytool`.

The Ed25519 update signing is **independent** of these OS signatures — keep all three
procedures current.
