# ClamAV Integration — Vibe Connect Appliance

## Scope

Real-time anti-virus scanning of attachment uploads, both staff-to-staff and
portal-to-firm. When configured, the appliance streams each uploaded blob into a
`clamd` daemon via the INSTREAM protocol before committing the attachment row as
`clean`. Infected uploads are deleted, rejected with HTTP 422, and audit-logged.

## When ClamAV is not configured

If `CLAMD_HOST` is blank (default), uploads are marked `clean` without scanning.
**This is fine for local development and CI but should never ship to a production
appliance.** The appliance is expected to have clamd reachable on the internal network.

## Adding clamd to `docker-compose.prod.yml`

```yaml
services:
  clamd:
    image: clamav/clamav:latest
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'clamdscan', '--ping', '1']
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 2m     # clamd loads ~300 MB of signatures on first boot
    volumes:
      - clam_sigs:/var/lib/clamav

  app:
    # … existing config …
    environment:
      CLAMD_HOST: clamd
      CLAMD_PORT: 3310
    depends_on:
      clamd:
        condition: service_healthy

volumes:
  clam_sigs:
    name: vibe_connect_clam_sigs
```

Then in the appliance `.env`:

```
CLAMD_HOST=clamd
CLAMD_PORT=3310
```

## Verifying it's working

Use the [EICAR test string](https://www.eicar.org/download-anti-malware-testfile/)
— a non-malicious pattern every AV engine recognizes.

```bash
echo -n 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > /tmp/eicar.txt
```

Upload `eicar.txt` through the client portal. The server should reject with
`422 {error: 'infected', signature: 'Eicar-Test-Signature'}` and the UI should
render the red "Rejected: virus scan flagged this file" banner.

Check the audit log:

```sql
SELECT action, details FROM audit_log
  WHERE action IN ('attachment.infected_rejected', 'portal.attachment_infected_rejected')
  ORDER BY created_at DESC LIMIT 5;
```

## Signature updates

`clamav/clamav:latest` pulls signatures via `freshclam` on container start and every
few hours afterward. Persist `/var/lib/clamav` so you don't re-download ~300 MB on
every restart.

## Performance & timeouts

Scans are **synchronous** — the upload request blocks until clamd returns a verdict.
For ≥50 MiB files this can be several seconds. The client sets a 30 s socket timeout
(see `scanBuffer` in `apps/server/src/services/clamav.ts`). If clamd is slow or
unreachable:

- `CLAMD_HOST` unset → clean-through (documented above).
- `CLAMD_HOST` set but unreachable → status `error` → treated as clean and logged
  at `warn`. **This is a safety/liveness tradeoff: prefer an admin-visible log over
  user-facing failure when the scanner is down.** Flip the policy by editing
  `conversations.ts` / `portalUpload.ts` if you'd rather fail-closed.

## Why stream the ciphertext?

We send the encrypted envelope (not the plaintext) to clamd. This is intentional:

- **We can't decrypt server-side** — the plaintext is only ever in the sender or
  recipient browser. Sending plaintext would require a plaintext-window on the
  server that breaks CLAUDE.md's crypto invariants.
- **Pattern matching still catches known-bad bytes.** Signature-based AV engines
  recognize raw byte patterns; known file types (PDFs, Office docs) with embedded
  exploits still have recognizable byte strings that survive our envelope.
- **Attackers who hand-craft ciphertext** that decrypts to malware but doesn't
  trigger the scanner are a theoretical concern; the primary threat is a client
  uploading a commodity malware sample unmodified.

If you want plaintext scanning, implement a "scan subprocess" that unwraps the
wrapped-file-key under admin control and scans the decrypted body in a sandboxed
process, then re-encrypts. That path is documented in the Phase 21 plan and not
implemented yet — the threat model and legal surface are non-trivial.
