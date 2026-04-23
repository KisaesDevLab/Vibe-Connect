# Backup & Recovery — Vibe Connect Appliance

## What has to be backed up together

Three things form a single backup unit. Without all three you cannot restore a working
server:

1. **Postgres dump** (`pg_dump`) — structure + all ciphertext + all wrapped keys.
2. **Attachments volume** (`vibe_connect_uploads`) — the ciphertext files referenced by
   `attachments.storage_path`.
3. **Firm key material** — the encrypted `firm_keys.encrypted_recovery_private_key` is
   already in the Postgres dump, but you also need the `firm_key_public` env var (stored
   in `.env` / secret store).

The **recovery phrase is NOT in backup**. The managing partner holds it separately on
paper. Losing the phrase means losing access to every external conversation forever.

## Backup command (daily via Duplicati)

```bash
docker exec vibe-connect-postgres pg_dump -U vibe -F c vibe_connect > /backup/vibe_$(date +%F).pgc
docker run --rm -v vibe_connect_uploads:/u -v /backup:/backup alpine \
  tar -czf /backup/uploads_$(date +%F).tgz -C /u .
cp /srv/vibe-connect/.env /backup/env_$(date +%F).env
```

Encrypt the bundle with Duplicati using a passphrase that lives in the partner's safe.

## Restore to a fresh appliance

1. Install Docker + pull the same appliance image version.
2. Restore `.env` and `docker compose up -d postgres`.
3. `pg_restore -U vibe -d vibe_connect /backup/vibe_<date>.pgc`
4. Restore uploads: `tar -xzf uploads_<date>.tgz -C /var/lib/docker/volumes/vibe_connect_uploads/_data/`
5. `docker compose up -d app nginx`
6. Log in as the managing partner on the staff site; the firm recovery phrase only comes
   into play for emergency decryption, not login.

Target: full restore on fresh hardware in < 15 minutes.

## Validation check after restore

- `curl https://connect.<firm>/health` → `{"ok":true}`
- Admin → Device health → all recent heartbeats visible.
- Open the most recent staff conversation, confirm messages decrypt.
- Use `/admin/export` with the recovery phrase on an external conversation to prove the
  emergency path still works.
