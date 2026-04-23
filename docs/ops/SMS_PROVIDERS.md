# SMS providers — TextLink (primary) + Twilio (alternative)

Both adapters live in `apps/server/src/bridges/sms/` and implement the same
`SmsProvider` interface. Switch via `.env` → `SMS_PROVIDER=textlink|twilio|mock`.

## TextLink (BYOD Android + SIM)

Recommended because the SIM plan is flat-rate and no 10DLC approval is needed.

1. Buy a dedicated Android phone + unlimited-SMS SIM. Keep it powered and on the firm's
   guest Wi-Fi.
2. Install TextLink on the phone, sign in with the firm's account.
3. Set the outbound API key into `.env` → `TEXTLINK_API_KEY`.
4. Configure the webhook target `https://connect.<firm>/conversations/sms-inbound` and
   copy the shared secret to `.env` → `TEXTLINK_WEBHOOK_SECRET`.
5. Test: from the admin app, send a test to your own number.

Failure modes to document for the firm:
- Phone dies → outbound stalls until it's back online.
- SIM throttled → cap alert at 80% / 100% of monthly cap (see `firm_settings.sms_monthly_cap`).

## Twilio 10DLC (alternative)

Use when the firm cannot run the BYOD Android.

1. Register Brand + Campaign with Twilio (2–4 weeks external gating).
2. Provision a 10DLC number; attach to a Messaging Service.
3. Set `.env` → `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_FROM_NUMBER`.
4. Configure the webhook to `https://connect.<firm>/conversations/sms-inbound` and use
   Twilio's signature verification (built into the adapter).

## TCPA compliance (both providers)

- Explicit opt-in required before any outbound SMS — captured on the portal intake form.
- `STOP | UNSUBSCRIBE | CANCEL` on inbound → immediate opt-out, auto-reply confirming.
- `START | UNSTOP` → re-opt-in.
- Audit trail viewable under Admin → Audit log (filter action `sms.opt_in` /
  `sms.opt_out`).
- Recipient timezone honoured; no SMS between 21:00–08:00 local unless urgent.

## Monitoring

Admin banner triggers at 80% and 100% of `sms_monthly_cap` — less relevant for TextLink
(flat SIM) but essential for Twilio (cost control).
