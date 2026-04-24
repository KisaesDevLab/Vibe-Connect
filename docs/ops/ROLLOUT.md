# Kisaes rollout runbook

6-week parallel run alongside PinkNotes. All non-code steps are owner-gated by Kurt.

## Gate — Phase 16 sign-off

`docs/SECURITY_REVIEW.md` must end with "Sign-off: GO" before proceeding.

## Observability notes for upgrades from pre-1.0 builds

- **`X-Request-Id` format changed.** Client-supplied values (from nginx /
  Tauri / upstream proxies) now appear in logs and the `audit_log.details.reqId`
  column with an `ext:` prefix — e.g., a client-set `abc-123` is logged as
  `ext:abc-123`. Server-minted IDs are still bare 8-hex. If your log
  aggregator joins server logs with an upstream nginx log by request id,
  strip the prefix at the aggregator side, or update the query to match
  both forms. See `apps/server/src/middleware/requestLog.ts` for the rule.
- **Attachment `envelope_format` column added.** New column distinguishes
  `conversation-key-v1` (staff / portal uploads) from `bridge-sealed-v1`
  (inbound email attachments). API responses now include
  `attachment.envelopeFormat`. Existing tooling that reads attachments
  doesn't need to change — the default backfills every existing row to
  `conversation-key-v1`, matching the pre-column behaviour.

## Week 0 — Install & Kurt solo

- [ ] Appliance provisioned on Kisaes NucBox M6.
- [ ] DNS:
  - [ ] `connect.kisaes.com` → appliance IP
  - [ ] `portal.kisaes.com` → appliance IP
- [ ] TLS certs placed at `infra/docker/tls/connect.{crt,key}` and `portal.{crt,key}`.
- [ ] `.env` written; `POSTGRES_PASSWORD`, `SESSION_SECRET`, VAPID keys generated.
- [ ] `docker compose -f infra/docker/docker-compose.prod.yml up -d`
- [ ] `curl https://connect.kisaes.com/health` → `{"ok":true}`
- [ ] First-boot: `POST /install/install` — capture recovery phrase, seal in envelope, hand to Kurt.
- [ ] Kurt signs in → enrolls first device → sends a self-note.
- [ ] Backups: Duplicati job scheduled → first restore test to a staging VM within 24h.

## Week 1 — Kurt exclusive

Kurt is the only active user. Goal: dogfood every feature, find the sharp edges.

- [ ] Daily: 1 conversation, 5 messages, 1 urgent, 1 scheduled, 1 edit, 1 delete.
- [ ] Daily: confirm desktop notifications fire, tray icon works, hotkey works.
- [ ] Daily: verify `/admin/audit` shows every action.

## Week 2 — Opt-in staff (Alice, Bob, Carol)

- [ ] Create users via `/admin/users/bulk` or Users tab.
- [ ] Send each their initial password + the "PinkNotes vs Vibe Connect" 1-pager (see below).
- [ ] Each staff: first login → device enrollment → send one message to Kurt.
- [ ] Daily 10-min standup collecting friction notes.

## Week 3 — Full staff, PinkNotes parallel

- [ ] Remaining staff onboarded.
- [ ] PinkNotes kept running but a sign is posted: "Daily work in Vibe Connect from today."
- [ ] Pin both apps to the taskbar during this week.

## Weeks 4–6 — Daily feedback + SLA

- [ ] 24h SLA for critical bugs (encryption, message loss, login outage).
- [ ] 1-week SLA for medium bugs.
- [ ] End-of-week review with Kurt: triage new tickets, decide what to ship.

## End of Week 6 — Go / no-go decision

| Criterion | Met? |
|-----------|------|
| 0 critical incidents in Weeks 4–6 | |
| All staff prefer Vibe Connect in exit poll | |
| Daily-message volume on Vibe ≥ 2× PinkNotes | |
| Admin can produce an audit export in < 5 min | |

If all met: retire PinkNotes. If not: extend parallel run by 4 weeks and re-review.

## Training 1-pager (hand to every staff member)

### PinkNotes vs Vibe Connect

|                          | PinkNotes         | Vibe Connect                       |
|--------------------------|-------------------|-----------------------------------|
| Subject line             | yes               | NO — message body only             |
| "Must Reply" / flags     | yes               | NO — use Urgent ⚡ or Ack 👍        |
| Sending                  | Send              | Enter to send, Shift+Enter newline |
| Edit after send          | no                | yes, within 15 minutes             |
| Encryption               | none              | end-to-end, firm-recoverable        |
| Search                   | server-side       | browser-side, over YOUR messages   |
| Attachments              | ~10 MB            | up to 100 MB, encrypted            |
| Client messages          | email only        | portal + email + SMS all secure    |
| Mobile                   | desktop only      | PWA on phone; notifications too    |

### Day-1 checklist

- [ ] Sign in at `https://connect.kisaes.com`
- [ ] Enroll your device (enter your password again)
- [ ] Send "hello from Vibe" to Kurt
- [ ] Open the tray icon → pin to system tray
- [ ] Open `/notifications` → enable desktop + push

### If something breaks

Message Kurt in Vibe Connect. If Vibe is the thing that's broken, email Kurt with the word
**"VIBE DOWN"** in the subject.

## Critical-incident playbook

1. **Mass message loss** → stop writes (flip `MAINTENANCE=true`), check Postgres, restore from last backup.
2. **Cannot log in** → check session table `SELECT COUNT(*) FROM session;`; rotate `SESSION_SECRET` if compromised.
3. **Emergency decryption needed** (partner subpoena): Kurt opens `/admin/export`, pastes recovery phrase, client-side export unpacks.
4. **Recovery phrase lost** → CANNOT be recovered. See `docs/THREAT_MODEL.md`.
5. **Device compromise suspected** → `/admin/devices` → Revoke → conversation keys rotate automatically on next member change; manually rotate for critical threads.
