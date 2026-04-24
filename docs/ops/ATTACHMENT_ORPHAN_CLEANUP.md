# Attachment Orphan Cleanup

Attachments live in two places: a row in `attachments` table (DB) and a
blob on the storage driver (local filesystem or S3). The write paths try
to keep these aligned, but three failure modes can leave an orphan:

1. **Storage put succeeded, DB insert failed** — The blob is on disk but
   nothing in `attachments` points at it. The post-put try/catch in the
   email bridge and the portal/staff upload routes make a best-effort
   delete, but a second failure at that step leaves the blob for good.

2. **Retention batch committed, storage delete failed** — The retention
   sweep deletes the `attachments` row inside a DB transaction, then
   deletes the blob. If the blob delete throws (FS permissions, transient
   S3), the row is gone but the bytes remain.

3. **Legacy rows** — Installs that predate the envelope-format marker may
   have rows whose `envelope_format` is the default `'conversation-key-v1'`
   but whose wrapped_file_key is unreadable (e.g., a rekey rolled the
   conversation key without a rewrap pass). The row is valid metadata but
   the blob is unreachable.

## Detection

Walk the storage directory (or S3 `ListObjectsV2`), compare against the
`attachments.storage_path` set, and flag anything in the filesystem that
isn't claimed by a row.

```sh
# Local driver — adjust path to ATTACHMENT_LOCAL_DIR + /attachments
find /var/lib/vibe-connect/uploads/attachments -type f -name '*.bin' > /tmp/on_disk.txt
psql -At -c "SELECT storage_path FROM attachments WHERE storage_path != ''" > /tmp/in_db.txt
comm -23 <(sort /tmp/on_disk.txt) <(sort /tmp/in_db.txt) > /tmp/orphans.txt
```

For S3:

```sh
aws s3api list-objects-v2 --bucket $S3_BUCKET \
  --query 'Contents[].Key' --output text | tr '\t' '\n' | sort > /tmp/on_s3.txt
psql -At -c "SELECT storage_path FROM attachments WHERE storage_path != ''" > /tmp/in_db.txt
comm -23 /tmp/on_s3.txt /tmp/in_db.txt > /tmp/orphans.txt
```

## Remediation

After reviewing `/tmp/orphans.txt` (there may be in-flight uploads — run
this during low traffic or subtract anything newer than ~5 minutes), the
orphans can be removed:

```sh
# Local driver
while read path; do rm -f "$path"; done < /tmp/orphans.txt
# S3 driver — batched delete-objects form is faster for >1000 keys
xargs -a /tmp/orphans.txt -I{} aws s3 rm s3://$S3_BUCKET/{}
```

## Frequency

Run monthly as part of routine ops, or after any incident that logs
`retention.attachment_delete_failed` or `email.inbound_attachment_failed`
more than a handful of times in the hour.
