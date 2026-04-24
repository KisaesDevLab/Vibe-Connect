# Rotating `SESSION_SECRET`

`SESSION_SECRET` is the root from which several independent server-side KEKs
are derived via HKDF-SHA256. Rotating it invalidates every value that was
sealed under the old key. This doc lists what breaks so an operator can plan
the rotation instead of discovering the breakage post-hoc.

## What derives from SESSION_SECRET

1. **Server-side sessions (express-session).**
   Rotation invalidates every active staff session. Users must sign in again.
   This is the intended behaviour of rotating a session secret and is usually
   the whole point of the operation (post-incident forced logout).

2. **Provider credentials (`firm_provider_credentials`).**
   Postmark / Twilio / SMTP / Textlink tokens stored via the Admin →
   Providers UI are sealed with `HKDF(SESSION_SECRET, 'vibe-connect/provider-secrets/v1')`.
   After rotation, `services/providerSecrets.ts::get()` returns `null` for
   every stored value — outbound email and SMS will fail until an admin
   re-enters each credential. The server logs `provider_secret_decrypt_failed`
   once per key, per process.

3. **ACME account key (`tls_acme_account_key_sealed`).**
   Sealed with the same KEK. After rotation, the next ACME order must
   generate a fresh account key and register it with Let's Encrypt. Existing
   issued certs on disk are unaffected; only the account key used for
   ordering new/renewal certs needs re-provisioning.

4. **Avatar ciphertext (files on disk under `ATTACHMENT_LOCAL_DIR/avatars/`).**
   Each avatar is encrypted with `HKDF(SESSION_SECRET, ..., 'vibe-connect-avatars', 32)`.
   After rotation, avatars become unreadable (404 / broken image). The
   encrypted files are harmless and can be deleted with
   `rm -rf $ATTACHMENT_LOCAL_DIR/avatars/*`. Users will need to re-upload.

5. **Unsubscribe tokens in previously-sent emails.**
   HMAC-SHA256 over payload with SESSION_SECRET as the key. After rotation,
   any outstanding unsubscribe link in an already-delivered email returns
   `unauthorized`. Recipients can still unsubscribe by simply ignoring
   further messages — or operators can re-mail the notification if unsubscribe
   retention matters.

## What does NOT derive from SESSION_SECRET

- **Conversation content.** End-to-end encryption uses per-conversation keys
  wrapped to device public keys; nothing about SESSION_SECRET touches message
  ciphertext. Rotation does not affect any historical conversation.
- **Firm recovery phrase.** The firm private key is wrapped with a key
  derived from the 24-word phrase, not SESSION_SECRET.
- **Device passphrases.** Client-side Argon2id; server never sees them.
- **Client portal sessions (`client_sessions`).** Stored as SHA-256 hashes
  of raw tokens, not sealed with KEK. Rotation does not invalidate portal
  sessions. To force a full client logout, truncate `client_sessions` or
  set `revoked_at` across the board via the admin UI.

## Rotation runbook

```bash
# 1. Generate a new secret (48 bytes of base64url is plenty).
python3 -c "import secrets; print(secrets.token_urlsafe(48))"

# 2. Drain provider-secret re-entry pre-emptively: list currently configured
#    keys so an admin can collect the values before rotation.
docker compose exec app node -e \
  "require('./apps/server/dist/services/providerSecrets.js').metaList().then(m => console.log(m))"

# 3. Update SESSION_SECRET in the appliance .env and restart.
echo 'SESSION_SECRET=<new-value>' >> .env   # or editor of choice
docker compose -f infra/docker/docker-compose.prod.yml up -d app

# 4. Post-restart tasks (in order):
#    a. Admin signs in (pre-rotation sessions are dead).
#    b. Re-enter each provider credential in Admin → Providers.
#    c. Trigger a renewal in Admin → TLS so a new ACME account key is
#       generated and registered.
#    d. (Optional) delete old avatar ciphertext: rm -rf ...
```

## Detection

After rotation, watch `logger.warn('provider_secret_decrypt_failed', ...)`
in the first 5 minutes. Any non-zero count confirms step 4b is pending.
