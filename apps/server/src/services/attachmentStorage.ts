// Attachment storage abstraction. Supports local-disk (default) and S3-compatible
// object storage (AWS S3, MinIO, R2, etc.) behind a single interface.
//
// CRYPTO: files handed to these drivers are ALREADY ciphertext — encryption/decryption
// happens client-side. The driver never sees plaintext. storage_path values stored in the
// `attachments` table are driver-opaque keys.
import type { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../env.js';

export interface AttachmentStorage {
  /**
   * Store the ciphertext buffer and return a driver-opaque key (saved as
   * `attachments.storage_path`). Callers must not interpret the returned value.
   */
  put(key: string, body: Buffer): Promise<string>;
  /** Return the ciphertext bytes for a previously-returned key. */
  get(key: string): Promise<Buffer>;
  /** Remove the blob if present; never throws on missing. */
  delete(key: string): Promise<void>;
}

class LocalStorage implements AttachmentStorage {
  constructor(private readonly dir: string) {}

  async put(key: string, body: Buffer): Promise<string> {
    const safe = sanitizeKey(key);
    const full = path.join(this.dir, safe);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
    return safe;
  }

  async get(key: string): Promise<Buffer> {
    const safe = sanitizeKey(key);
    const full = path.join(this.dir, safe);
    if (!full.startsWith(this.dir + path.sep) && full !== this.dir) {
      throw new Error('path_traversal');
    }
    return fs.readFile(full);
  }

  async delete(key: string): Promise<void> {
    const safe = sanitizeKey(key);
    const full = path.join(this.dir, safe);
    try {
      await fs.unlink(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

class S3Storage implements AttachmentStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    opts: {
      region: string;
      endpoint?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    },
  ) {
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint || undefined,
      // Path-style is required for MinIO and many R2 setups; harmless against AWS.
      forcePathStyle: Boolean(opts.endpoint),
      credentials:
        opts.accessKeyId && opts.secretAccessKey
          ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
          : undefined,
    });
  }

  async put(key: string, body: Buffer): Promise<string> {
    const safe = sanitizeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: safe,
        Body: body,
        ContentType: 'application/octet-stream',
        // Server-side encryption at rest. Clients have already encrypted the body end-to-end;
        // SSE is defense-in-depth for the bucket's own metadata and in case the object ever
        // leaks onto disk outside the ciphertext boundary.
        ServerSideEncryption: 'AES256',
      }),
    );
    return safe;
  }

  async get(key: string): Promise<Buffer> {
    const safe = sanitizeKey(key);
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: safe }),
    );
    const stream = out.Body as Readable | undefined;
    if (!stream) throw new Error('empty_body');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    const safe = sanitizeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safe }));
  }
}

function sanitizeKey(key: string): string {
  // Keys must be relative, non-empty, and must not traverse. Callers generate them from
  // message_id + timestamp so uniqueness + safety hold, but we defend anyway.
  const trimmed = key.replace(/^[/\\]+/, '');
  if (trimmed.length === 0 || trimmed.includes('..')) {
    throw new Error('invalid_storage_key');
  }
  return trimmed.replace(/\\/g, '/');
}

let shared: AttachmentStorage | null = null;

export function attachmentStorage(): AttachmentStorage {
  if (shared) return shared;
  if (env.attachmentDriver === 's3') {
    if (!env.s3Bucket) throw new Error('S3_BUCKET is required when ATTACHMENT_DRIVER=s3');
    shared = new S3Storage(env.s3Bucket, {
      region: env.s3Region || 'us-east-1',
      endpoint: env.s3Endpoint,
      accessKeyId: env.s3AccessKeyId,
      secretAccessKey: env.s3SecretAccessKey,
    });
    return shared;
  }
  shared = new LocalStorage(path.resolve(env.attachmentLocalDir, 'attachments'));
  return shared;
}

/** Convenience passthrough for callers that want to stream a local file instead of buffering. */
export function localReadStream(key: string): NodeJS.ReadableStream {
  if (env.attachmentDriver !== 'local') {
    throw new Error('localReadStream called with non-local driver');
  }
  const safe = sanitizeKey(key);
  const dir = path.resolve(env.attachmentLocalDir, 'attachments');
  return createReadStream(path.join(dir, safe));
}
