# OIDC / SSO — Vibe Connect Appliance

## Scope

Vibe Connect supports a single OpenID Connect provider for staff sign-in. Users whose
IdP login succeeds are JIT-provisioned on first login (matched by email). An optional
claim-value match promotes a user to firm admin.

> **Crypto note.** OIDC only authenticates the user. Device key enrollment still
> requires a passphrase the SSO user picks at first-enrollment time — the server
> never sees this passphrase and it is what wraps the per-device X25519 private key.
> This preserves end-to-end encryption for SSO users. See
> `apps/server/src/routes/oidc.ts` for the top-of-file note.

## Environment

```
OIDC_ISSUER_URL=           # blank disables SSO
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_REDIRECT_URI=https://connect.yourfirm.com/auth/oidc/callback
OIDC_SCOPES=openid email profile

# Optional: promote users whose ID-token claim matches value to firm admin on first login.
OIDC_ADMIN_CLAIM=groups
OIDC_ADMIN_CLAIM_VALUE=vibe-firm-admins
```

`GET /auth/oidc/config` returns `{enabled:true, loginUrl:'/auth/oidc/login'}` once
issuer discovery succeeds, and the staff login page renders an extra "Sign in with
SSO" button below the password form.

## Protocol

- **Authorization Code + PKCE (S256)** — no implicit flow, no refresh tokens held
  server-side.
- **State + nonce** are stored in the server session before the browser is redirected
  and verified on the callback, defeating CSRF and token replay.
- **ID-token signature** is validated against the provider's JWKS by the
  `openid-client` library; JWKS is refreshed by the library on rotation.

## Configuration walkthroughs

### Google Workspace

1. Cloud Console → APIs & Services → Credentials → **Create OAuth Client ID** → Web application.
2. Authorized redirect URI: `https://connect.yourfirm.com/auth/oidc/callback`.
3. Copy client ID + secret.
4. In `.env`:
   ```
   OIDC_ISSUER_URL=https://accounts.google.com
   OIDC_CLIENT_ID=<copied>
   OIDC_CLIENT_SECRET=<copied>
   OIDC_REDIRECT_URI=https://connect.yourfirm.com/auth/oidc/callback
   OIDC_SCOPES=openid email profile
   ```
5. Google does not emit a `groups` claim by default; to use admin auto-promotion,
   integrate with Workspace directory via a separate admin SDK call (out of scope
   here) or rely on manual admin promotion from the Admin → Users page.

### Microsoft Entra ID (Azure AD)

1. Entra admin center → **App registrations** → New registration → Web platform.
2. Redirect URI: `https://connect.yourfirm.com/auth/oidc/callback`.
3. Under **Certificates & secrets** → New client secret.
4. Under **Token configuration** → Add groups claim → "Groups assigned to the
   application" → emit groups as **Group ID** (not DisplayName).
5. Under **App roles** or pre-existing groups: note the object ID of the group that
   should grant admin.
6. In `.env`:
   ```
   OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0
   OIDC_CLIENT_ID=<app-id>
   OIDC_CLIENT_SECRET=<client-secret>
   OIDC_REDIRECT_URI=https://connect.yourfirm.com/auth/oidc/callback
   OIDC_SCOPES=openid email profile
   OIDC_ADMIN_CLAIM=groups
   OIDC_ADMIN_CLAIM_VALUE=<group-object-id>
   ```

### Okta

1. Okta Admin → Applications → Create App Integration → OIDC → Web Application.
2. Sign-in redirect: `https://connect.yourfirm.com/auth/oidc/callback`.
3. Grant types: Authorization Code.
4. Copy client ID + secret.
5. In `.env`:
   ```
   OIDC_ISSUER_URL=https://<your-okta-domain>/oauth2/default
   OIDC_CLIENT_ID=<copied>
   OIDC_CLIENT_SECRET=<copied>
   OIDC_REDIRECT_URI=https://connect.yourfirm.com/auth/oidc/callback
   OIDC_SCOPES=openid email profile groups
   OIDC_ADMIN_CLAIM=groups
   OIDC_ADMIN_CLAIM_VALUE=VibeConnectAdmins
   ```
   You'll need to add a groups claim to the default authorization server (Okta →
   Security → API → Authorization Servers → default → Claims → Add Claim, include
   groups matching regex `.*`).

## JIT provisioning semantics

- First login with a new email → a new row in `users` with:
  - `username` = `{local-part-of-email}.{6-char-sub-hash}` (slugified)
  - `email` = lowercase claim value
  - `display_name` = `name` / `preferred_username` / email / sub (in fallback order)
  - `password_hash` = random unrecoverable hash (SSO users cannot password-login)
  - `is_admin` = true only if `OIDC_ADMIN_CLAIM` matches
- Subsequent logins re-use the existing row. If `is_admin` was revoked manually in
  the Admin UI but the claim still matches, the admin bit is **re-granted** on
  each SSO login. Remove the user from the claim group to permanently demote.
- Deactivated users (`is_active=false`) get a 403 at the SSO callback with a
  visible "account deactivated" message; they cannot log in.

## Auditing

Every SSO login writes an audit row:

```sql
SELECT created_at, action, details FROM audit_log
  WHERE action LIKE 'auth.oidc_%' ORDER BY created_at DESC;
```

Actions:
- `auth.oidc_user_created` — new JIT user.
- `auth.oidc_login` — existing user signed in.

## Disabling SSO

Blank any of `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
`OIDC_REDIRECT_URI` and restart the app container. The login page's "Sign in with
SSO" button disappears and `/auth/oidc/login` returns 503.

Existing SSO-provisioned users remain in the `users` table with their unrecoverable
password hash. Admin can reset their password via Admin → Users → Reset password to
let them log in without SSO.
