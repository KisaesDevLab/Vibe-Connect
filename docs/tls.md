# TLS — Let's Encrypt automation

The appliance ships with self-signed certs in `infra/docker/tls/`. Admin → TLS
replaces those with a browser-trusted Let's Encrypt cert when the deployment
is publicly reachable.

## Prerequisites (HTTP-01, Phase 1)

Let's Encrypt's HTTP-01 challenge validates ownership by fetching a token
over **port 80 at each hostname** on the cert. So:

1. DNS **A records** for both hostnames (staff site + client portal, if used)
   pointing at the appliance's public IP.
2. **Port 80 reachable** from the internet (`104.26.0.0/16` and friends —
   LE's validators). Cloud VPS with a public IP is the happy path.
3. **Port 443 and 8443** reachable for browsers to actually use the cert.

LAN-only / NAT'd deployments can't pass HTTP-01. DNS-01 support is Phase 2.

## Issuing a certificate

1. Open **Admin → TLS**.
2. Fill in:
   - *Staff site domain* (e.g. `connect.example.com`) — matches whatever
     staff type into their browser on port 443.
   - *Client portal domain* (e.g. `portal.example.com`) — optional; leave
     blank to reuse the staff cert for both.
   - *ACME account email* — Let's Encrypt sends expiry + policy warnings here.
   - *Environment* — leave on **Staging** for the first issuance. Staging has
     generous rate limits but produces certs browsers don't trust. Flip to
     **Production** only after you've verified the staging cert works.
3. Click **Request certificate**.
4. The status banner cycles `requesting → active` within ~60 seconds.
   `openssl s_client -connect connect.example.com:443 -servername connect.example.com`
   shows the issued cert.

## Renewal

A daily background job renews any cert within 30 days of expiry. The **Renew
now** button force-renews outside the 30-day window.

Renewals reuse the stored ACME account key — no new account is created each
time. The new cert file is written atomically (`.tmp` + rename) and nginx's
internal inotify loop reloads it within a second.

## Revocation / rollback

**Revoke & clear** on the TLS tab:

1. Revokes the active cert with Let's Encrypt (best-effort — a failure here
   is logged but doesn't block the cleanup).
2. Deletes `connect.{crt,key}` and `portal.{crt,key}` from the tls directory.
3. Wipes the cert metadata in `firm_settings`.
4. Nginx reloads and falls back to whatever `*.crt` files are present —
   typically the original self-signed bootstrap certs.

To put new self-signed bootstrap certs in place manually, drop them in the
host's `infra/docker/tls/` directory and nginx will reload within ~2 seconds.

## Storage + crypto

- **Cert + private key** live on disk at `infra/docker/tls/`. Same exposure
  profile as the original bootstrap certs — readable by the app + nginx
  containers via the bind mount. Rotate the host's disk encryption / file
  permissions per your org policy.
- **ACME account private key** is sealed in `firm_settings.tls_acme_account_key_sealed`
  using the same KEK pattern as provider credentials (HKDF-SHA256 of
  `SESSION_SECRET`). Rotating `SESSION_SECRET` invalidates the account key;
  the next cert request generates a fresh account.

## Rate limits

Let's Encrypt production limits (per account + per domain):

- 50 certificates per registered domain per rolling week.
- 5 failed validations per account per hostname per hour.
- 300 new orders per account per 3 hours.

The admin UI + server also rate-limit client-side: `POST /admin/tls/request`
and `/admin/tls/renew` are capped at 5 / hour per admin session so a
compromised session can't burn the account's LE budget.

## Auditing

Every state change lands in `audit_log`:

| Action | When |
|---|---|
| `admin.settings_updated` | Admin saves domains, email, environment, challenge type |
| `admin.tls_requested` | Manual issuance from the UI |
| `admin.tls_renewed` | Manual or automatic renewal |
| `admin.tls_revoked` | Revoke & clear |
| `admin.tls_cleared` | Revoke & clear wrap-up row |

No secret material is ever written to `details`.

## Troubleshooting

**`Invalid response from …/.well-known/acme-challenge/...`** — LE could
reach port 80 but got something other than the expected token. Confirm the
A record resolves to the appliance and no upstream proxy is intercepting
`.well-known/acme-challenge/`.

**`Connection refused` during validation** — port 80 isn't reachable from
the internet. Check firewall (AWS security group, UFW, `iptables -L`) and
that `docker compose ps` shows `docker-nginx-1` listening on `0.0.0.0:80`.

**`urn:ietf:params:acme:error:rateLimited`** — you tripped an LE limit. The
error message says which. Wait it out (usually 1 hour or 1 week); use the
staging environment for testing.

**Stale cert after renewal** — the reloader sidecar watches the tls mount
via `inotifywait`. Confirm `docker logs docker-nginx-1` shows
`[tls-reloader] cert change detected, reloading nginx` lines after each
renewal. If not, `docker compose restart nginx` is a manual fallback.

## Phase 2 roadmap

DNS-01 challenges via per-provider credential plumbing:

- Cloudflare API token
- Route 53 IAM credentials
- Gandi API
- Manual mode (operator copies the TXT record)

Implementation shape mirrors `apps/server/src/bridges/sms/` — a
`DnsProvider` interface with one implementation per provider, credentials
stored via `services/providerSecrets.ts`. The `ChallengeStrategy` slot in
`services/tlsAcme.ts` is already in place for this.
