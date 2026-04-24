# Attachment Storage — Vibe Connect Appliance

## Scope

Choosing the backend for ciphertext attachment blobs. All attachment bytes are
**already encrypted client-side** before they reach the server, so the storage driver
never sees plaintext. This doc is about durability and operational cost, not
confidentiality.

## Drivers

Two drivers ship today; both are behind the same interface in
`apps/server/src/services/attachmentStorage.ts`.

### 1. `local` (default)

Bytes live under `${ATTACHMENT_LOCAL_DIR}/attachments/` on the appliance's disk. In
the Docker deployment this is the named volume `vibe_connect_uploads` mounted at
`/app/uploads`.

Pros: zero extra moving parts; backup runbook covers it with `tar`.
Cons: single-host durability only; disk failure = blob loss.

```
ATTACHMENT_DRIVER=local
ATTACHMENT_LOCAL_DIR=/app/uploads
ATTACHMENT_MAX_BYTES=104857600   # 100 MB cap
```

### 2. `s3` (AWS S3, MinIO, Cloudflare R2, Backblaze B2)

```
ATTACHMENT_DRIVER=s3
S3_BUCKET=your-bucket-name
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIA…
S3_SECRET_ACCESS_KEY=…
# Only set for non-AWS providers; enables path-style addressing.
S3_ENDPOINT=                       # AWS: leave blank
# S3_ENDPOINT=https://minio.local:9000
# S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
```

The driver sets `ServerSideEncryption=AES256` on every `PutObject` as
defense-in-depth against the bucket itself leaking on disk; this is on top of the
client-side XChaCha20-Poly1305 envelope.

### Bucket IAM (AWS example)

Minimum IAM policy for the Vibe Connect service principal:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    },
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::your-bucket-name" }
  ]
}
```

No `PutBucketPolicy`, no `*` in Action, no list on other buckets.

### MinIO quickstart

```bash
docker run -d --name minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=vibe -e MINIO_ROOT_PASSWORD=changeme-long-password \
  -v minio_data:/data \
  quay.io/minio/minio server /data --console-address ":9001"

# Create bucket via mc:
mc alias set local http://localhost:9000 vibe changeme-long-password
mc mb local/vibe-connect-attachments
```

Then in the appliance `.env`:
```
ATTACHMENT_DRIVER=s3
S3_BUCKET=vibe-connect-attachments
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=vibe
S3_SECRET_ACCESS_KEY=changeme-long-password
S3_ENDPOINT=http://minio:9000
```

## Switching drivers

Switching **does not migrate existing blobs**. Rows in the `attachments` table keep
their original `storage_path`, so reads for pre-switch attachments will 404 under the
new driver until you backfill.

To migrate local → S3:

```bash
# Sync local files into the bucket with matching keys.
aws s3 sync /var/lib/docker/volumes/vibe_connect_uploads/_data/attachments/ \
            s3://your-bucket-name/

# Then flip ATTACHMENT_DRIVER=s3 in .env and restart the app container.
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env up -d app
```

No DB change required — the `storage_path` values already look like
`<message-id>-<ts>.bin` and both drivers interpret them as opaque keys.

To migrate S3 → local, reverse the `sync` and flip `ATTACHMENT_DRIVER=local`.

## Observability

- Every upload writes an `audit_log` row with action `attachment.uploaded` (staff)
  or `portal.attachment_uploaded` (portal).
- Infected uploads log `attachment.infected_rejected` with the ClamAV signature.
- The driver itself is silent on success; check server logs for `clamav.*` and upload
  errors.

## Size limits

`ATTACHMENT_MAX_BYTES` is enforced in the multer middleware before bytes reach the
driver. Default is 100 MiB. Set to a lower value in CPA environments if you don't
expect to move large PDFs; lower limits reduce blast radius for DoS-via-large-upload
attacks.
