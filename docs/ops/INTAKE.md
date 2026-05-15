# Vibe File Transfer (Intake) — Operator Runbook

> Phase 28 of the Vibe Connect build plan. Anonymous-friendly client file
> intake at `/intake`, `/intake/:staffId`, and tokenized links at
> `/intake/t/:token`. **Server-side encryption at rest with a firm-held
> libsodium key — NOT E2EE.** See
> [ADR-028](../ADR-028-server-side-encryption-rationale.md) for the
> rationale and the user-facing disclosure contract.

This runbook is for the **appliance operator** (the human who deploys the
container image and rotates secrets). For day-to-day firm admin tasks
(staff cards, links, retention settings) see
[INTAKE_FIRM_ADMIN.md](./INTAKE_FIRM_ADMIN.md).

---

## Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `CONNECT_INTAKE_ENCRYPTION_KEY` | **yes** (prod) | 32 random bytes, base64. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Independent of `SESSION_SECRET`. |
| `CONNECT_INTAKE_ENCRYPTION_KEY_NEW` | only during rotation | Same shape. Removed after the operator promotes the new key. See [Key rotation](#key-rotation). |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | optional | Cloudflare Turnstile for the public `POST /sessions`. Both blank → no challenge (default). Both set → required. |
| `CLAMD_HOST` / `CLAMD_PORT` | optional | ClamAV sidecar address. `clamav:3310` in the bundled `docker-compose.yml`. When unreachable, uploads still complete but the scan status is `error` and the staff view flags it. |

`.env.example` carries safe defaults for dev (mock providers + a local
storage driver).

---

## Storage layout

Local-disk driver (default):

```
${ATTACHMENT_LOCAL_DIR}/attachments/
  intake/sessions/<sessionId>/<uuid>.bin    ← per-file ciphertext envelope
  intake/sessions/<sessionId>/assembled.pdf ← Phase 28.9 conversion output
```

Every blob is `header (24 bytes) || [u32 BE len][ct chunk]+ FINAL` —
XChaCha20-Poly1305 secretstream framed at 64 KiB chunks. The decrypt
path rejects any stream lacking the FINAL tag (truncation defense).

S3 driver (`ATTACHMENT_DRIVER=s3`): same key structure under the bucket
root; the driver adds `ServerSideEncryption=AES256` for defense in depth.

---

## Boot expectations

The server logs a `crypto.firm_key_loaded` line at startup with a short
fingerprint of the firm key. Intake does **not** log a fingerprint of
`CONNECT_INTAKE_ENCRYPTION_KEY` to avoid coupling it to general
operational logs; the key is only fingerprinted in audit rows during
rotation.

ClamAV expectations: the container should boot before the app or the
app's first scan attempts will log `clamd unreachable` and mark the
file `virus_scan_status='error'`. The bundled `docker-compose.yml`
already includes a depends_on/health-check pair.

Tickers started in-process at boot:

- `intakePdfConversionTicker` — claims pending `intake_pdfs` rows
- `intakeClientNotifyTicker` — drains `intake_notifications_outbox` rows with `template_id LIKE 'client.%'`
- `intakeStaffNotifyTicker` — drains the same outbox for `'staff.%'` / `'admin.%'`
- `intakeAutoPurgeTicker` — hourly retention sweep (Phase 28.15)

The key-rotation worker is **not** a ticker; it's an admin-initiated
async job started via `POST /admin/intake/rotate-key`.

---

## Key rotation

Rotating `CONNECT_INTAKE_ENCRYPTION_KEY` re-encrypts every PII column
and every encrypted blob on disk under a fresh key. Search-hash sidecar
columns are **not** rotated (they're HKDF-keyed off `SESSION_SECRET`,
not the intake key) — staff search continues to work across the cutover.

### When to rotate

- Key exposure (laptop with the env vault was lost, etc.).
- Periodic hygiene (annual or every regulatory cycle).
- Personnel change with broad ops access.

### Procedure

1. **Generate the new key**:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
2. **Set `CONNECT_INTAKE_ENCRYPTION_KEY_NEW`** alongside the existing
   `CONNECT_INTAKE_ENCRYPTION_KEY` and restart the appliance.
3. **Enable maintenance mode** so public writes are refused while the
   worker re-encrypts data:
   ```http
   POST /admin/intake/maintenance
   Content-Type: application/json
   { "enabled": true }
   ```
   The route is admin-only. While enabled, `POST /api/public/intake/sessions`,
   the tus upload endpoints, and `POST /sessions/:id/finalize` return
   `503 {"error":"maintenance"}`. Reads (`GET /staff`, `GET /links/:token`)
   stay live so an operator can confirm the appliance is reachable.
4. **Dry-run**:
   ```http
   POST /admin/intake/rotate-key/dry-run
   { }
   ```
   With no body, keys are taken from the two env vars. Returns counts +
   `sample.sessionDecryptOk` / `sample.fileDecryptOk` — both should be
   `true` before continuing.
5. **Run the rotation**:
   ```http
   POST /admin/intake/rotate-key
   { "batchSize": 100 }
   ```
   Returns `202 {jobId, counts, keyFingerprints:{old,new}}` immediately;
   the worker runs in-process. **Refuses with `409 maintenance_required`
   if maintenance mode is off.**
6. **Poll**:
   ```http
   GET /admin/intake/rotate-key/<jobId>
   ```
   Watch `processedSessions / totalSessions`. On a 10k-session corpus
   with default batch size, expect ~1 hour wall time (file streaming
   dominates).
7. **On success** (`status: "completed"`):
   - Swap env vars: `CONNECT_INTAKE_ENCRYPTION_KEY` ← old value of
     `CONNECT_INTAKE_ENCRYPTION_KEY_NEW`. Remove `_NEW`.
   - Restart the appliance.
   - Disable maintenance: `POST /admin/intake/maintenance {enabled:false}`.
8. **On failure** (`status: "failed"`):
   - Inspect `errorMessage` and the `intake.key_rotation.failed` audit
     row.
   - After fixing the cause, resume:
     ```http
     POST /admin/intake/rotate-key/<jobId>/resume
     { }
     ```
     The worker picks up at `lastProcessedSessionId + 1`.

### SIGTERM behavior

A SIGTERM during rotation flips `status='paused'` (worker checks
between rows). Restart leaves the row paused; resume the same way you
would after a failure.

### Verification

After a completed run, a 1% random sample is decrypt-tested under the
new key; the count appears in the `intake.key_rotation.completed`
audit detail as `verifySampled`. Every file blob also goes through a
per-row post-encrypt sha256 verification before the worker advances.

---

## Maintenance mode

`firm_settings.intake_maintenance_mode` is the boolean that gates
public writes. Flip via `POST /admin/intake/maintenance {enabled: ...}`
or directly in `firm_settings` if the appliance is offline. Reads are
unaffected; only `POST /sessions`, `POST /sessions/:id/finalize`, and
the tus upload routes return 503 when enabled.

The audit log records every toggle as `intake.maintenance.toggled`.

---

## Retention auto-purge

Driven by `firm_settings.intake_auto_delete_enabled` +
`intake_auto_delete_after_days` (range 30..3650). The hourly ticker
deletes finalized sessions whose `auto_delete_at` is past — writing
`intake.session.auto_purged` audit rows **before** the delete so the
forensic trail survives the cascade. See
[INTAKE_FIRM_ADMIN.md](./INTAKE_FIRM_ADMIN.md) for the firm-side
configuration UI.

---

## tus protocol limits

- Per-file cap: `firm_settings.intake_max_file_bytes` (default 50 MB).
- Per-session aggregate cap: `firm_settings.intake_max_session_bytes`
  (default 250 MB).
- Upload-token TTL: 4 hours from session create.
- Stale tus row reaper: piggy-backs on the vault retention sweep
  (vault_uploads_in_progress + intake_uploads_in_progress share the
  pattern).

---

## Audit log namespace

Every state-changing intake call writes to the shared `audit_log`
table with an `intake.*` action namespace. The Admin → Intake audit
tab is a pre-filtered view of this namespace; CSV export works the
same as the general audit page. **The audit_log row has no FK back to
intake tables**, so retention auto-purge does not orphan the trail.

A current event reference lives in
[INTAKE_FIRM_ADMIN.md § Audit log usage](./INTAKE_FIRM_ADMIN.md#audit-log-usage).

---

## Where to look when things go wrong

| Symptom | First place |
| --- | --- |
| Staff card grid empty | `firm_settings.show_on_intake_card` is `false` for everyone; flip via Admin → Intake cards. |
| Anonymous form 400 `unknown_staff` | The selected staff is not opted in or is deactivated. |
| Anonymous form 503 `maintenance` | Maintenance mode is on; check `firm_settings.intake_maintenance_mode`. |
| Uploads stuck `pending` | ClamAV unreachable. Check `docker compose logs clamav`. |
| Bridge `email` outbox file present but recipient didn't receive | Provider in `mock` mode (writes to `.outbox/`) not `postmark`/`postfix`. |
| PDF conversion stalls | Check `intake_pdfs.error_message`; auto-retries 3× then escalates to admin via `admin.pdf_conversion_failed` email row. |
| Decrypt fails after restart | Verify `CONNECT_INTAKE_ENCRYPTION_KEY` matches the value used pre-restart — log line `crypto.firm_key_loaded` shows the active firm-key fingerprint. |

---

## Defer / follow-up

The Phase 28 build plan called for two items that ship as follow-ups,
not as part of the 28.0–28.17 closeout:

- **Playwright E2E suite** for `/intake` flows. Not wired in this
  repository today. Adding it scoped to the intake feature is the next
  step when CI infrastructure budget allows.
- **k6 load test** (100 concurrent sessions × 10 × 1MB). Same.
- **True streaming CSV export** of `audit_log` via a Postgres cursor.
  Today's export caps at 10 000 rows per call (configurable to 100k);
  acceptable for typical firm-scale audit corpora but not unbounded.
