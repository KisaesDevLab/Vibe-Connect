# Email deliverability — SPF / DKIM / DMARC

The email bridge signs and sends from **`connect.<firmdomain>`**. Without the records
below, Postmark outbound will be rejected or silently spam-filed.

## SPF

```
connect.firmdomain.com.   TXT   "v=spf1 include:spf.postmarkapp.com -all"
```

## DKIM

Postmark will generate a CNAME pair when you register the Sender Signature:

```
<selector>._domainkey.connect.firmdomain.com.  CNAME  <selector>.domainkey.m1._domainkey.postmarkapp.com.
```

## DMARC

Start at `p=none` for the first 30 days, then tighten:

```
_dmarc.connect.firmdomain.com.  TXT  "v=DMARC1; p=none;   rua=mailto:dmarc-rua@firmdomain.com"
# After 30d of clean RUA reports:
_dmarc.connect.firmdomain.com.  TXT  "v=DMARC1; p=quarantine; pct=25; rua=mailto:dmarc-rua@firmdomain.com"
# Then:
_dmarc.connect.firmdomain.com.  TXT  "v=DMARC1; p=reject; rua=mailto:dmarc-rua@firmdomain.com"
```

## Verification

After records propagate:
- https://postmark-app.com/support/sender-signatures → green check.
- `dig TXT connect.firmdomain.com` shows SPF.
- `dig CNAME <selector>._domainkey.connect.firmdomain.com` resolves to the Postmark CNAME.

## Inbound

The bridge listens at `c+<token>@connect.firmdomain.com`. MX record:

```
connect.firmdomain.com.   MX  10  inbound.postmarkapp.com.
```

Set the Postmark inbound server to POST to `https://connect.<firmdomain>/conversations/email-inbound`
and capture the per-webhook secret — put it in `.env` as `POSTMARK_INBOUND_WEBHOOK_SECRET`.

## Fallback: self-hosted Postfix

If operating without Postmark, see `infra/docker/postfix.example.yml` (stub). The bridge
driver switches via `EMAIL_PROVIDER=postfix`.
