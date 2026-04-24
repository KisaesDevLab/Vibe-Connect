# Outbound Email — Vibe Connect Appliance

## Scope

Outbound email is used for: portal access-code delivery, step-up verification
messages, bridge outbound (when a staff message should be forwarded to a client's
regular email address), and operational notifications. Three providers ship:

- `mock` — writes JSON files to `${OUTBOX_DIR}/email/`; never contacts the network.
  Default for development.
- `postmark` — posts to Postmark's transactional API. Recommended for
  appliances that don't want to run their own MTA.
- `postfix` — raw SMTP via nodemailer. For firms running their own Postfix relay
  or connecting to a corporate MTA. **This is the most common production choice.**

Selection: `EMAIL_PROVIDER=mock|postmark|postfix`.

## Postfix / SMTP

```
EMAIL_PROVIDER=postfix
EMAIL_FROM=Vibe Connect <noreply@connect.yourfirm.com>
EMAIL_INBOUND_DOMAIN=connect.yourfirm.com

SMTP_HOST=smtp.yourfirm.com    # or a Postmark/SendGrid SMTP endpoint
SMTP_PORT=587
SMTP_USER=vibe-connect@yourfirm.com
SMTP_PASS=<credential>
SMTP_SECURE=false              # true = implicit TLS on 465; false = STARTTLS on 587
```

- `SMTP_PORT=587` + `SMTP_SECURE=false` is the modern default (STARTTLS upgrade
  after EHLO). Port 465 + `SMTP_SECURE=true` is legacy but widely supported.
- **Do not use port 25 from a non-MTA host.** Most consumer ISPs and cloud providers
  block outbound port 25 entirely; your appliance will silently fail to deliver.
- `SMTP_USER` + `SMTP_PASS` are optional. If both are blank the connection is
  unauthenticated (only works inside a trusted LAN to a relay that accepts the
  appliance's IP).

## Postmark

```
EMAIL_PROVIDER=postmark
POSTMARK_SERVER_TOKEN=abc-123-…
POSTMARK_INBOUND_WEBHOOK_SECRET=…   # only if you also use Postmark for inbound
EMAIL_FROM=Vibe Connect <noreply@connect.yourfirm.com>
```

Sender signature for `EMAIL_FROM` must be verified in Postmark. SPF + DKIM setup:
see `docs/ops/EMAIL_DNS.md`.

## Deliverability

SPF / DKIM / DMARC must be correct for your sending domain or your mail will
land in spam or get rejected. The `docs/ops/EMAIL_DNS.md` runbook walks through
the records. Test with mail-tester.com after configuration.

## Verifying outbound works

Trigger a portal access-code send:

```bash
curl -sk -X POST https://localhost/portal/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"client@example.com"}'
```

- `mock`: look in `${OUTBOX_DIR}/email/mock-*.json` inside the app container.
- `postmark`: check the Postmark activity feed for a message.
- `postfix`: tail your SMTP server logs (Postfix: `/var/log/mail.log`, Postmark SMTP:
  activity feed).

## Failure modes

- `EMAIL_PROVIDER=postfix` with `SMTP_HOST` unset → app throws on first send attempt.
  The error is logged but the admin-facing action that triggered it fails. Set
  `SMTP_HOST` or fall back to `EMAIL_PROVIDER=mock` while troubleshooting.
- Transient SMTP failures are **not retried in-app.** Phase 25 introduces a bounded
  retry queue; until then, tie up retries at your relay.
- Nodemailer connects lazily (first send) and caches the connection pool. Restart
  the app container to pick up SMTP credential changes.

## Never include message bodies in notifications

Per CLAUDE.md: outbound email notifications (e.g. "you have a new message")
**must never contain message content** — metadata + "open the portal/app" only.
The portal access-code flow is an exception because the code itself is the payload,
and it's single-use / time-boxed.

Audit that no code path violates this:

```bash
grep -rn "msg\.body\|message\.body" apps/server/src/bridges apps/server/src/services 2>&1 | grep -v test
```

Should return empty. If it ever returns a match, review carefully before merging.
