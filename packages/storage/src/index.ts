/**
 * Object storage for media people keep (avatars, covers, logos, voice notes), behind a small
 * vendor-neutral interface. Clients upload straight to storage via presigned URLs, never through the
 * API. Party source files never come here: they're read in memory and dropped (apps/api/src/files.ts).
 * Objects are private: reads go through short-lived presigned GETs.
 * The S3 implementation covers DO Spaces in production and SeaweedFS locally. No AWS SDK type leaves
 * this file.
 */
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface PresignedUpload {
  url: string;
  method: "PUT";
  /** Headers the client must send with the upload, exactly as given (they're part of the signature). */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface ObjectStore {
  presignPut(input: { key: string; contentType: string; contentLength: number; expiresSeconds: number }): Promise<PresignedUpload>;
  /** A short-lived URL to read a private object (voice note playback). */
  presignGet(input: { key: string; expiresSeconds: number }): Promise<{ url: string; expiresAt: string }>;
  /** The object's size, or null if it isn't there. */
  head(key: string): Promise<{ bytes: number } | null>;
  /** The whole object (small media only: the worker reads voice notes to transcribe them). */
  read(key: string): Promise<Uint8Array>;
  /** Deleting a missing object is not an error. */
  remove(key: string): Promise<void>;
}

const statusOf = (err: unknown) => (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

export interface S3StoreConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style URLs (http://host/bucket/key): needed for SeaweedFS/local, harmless for Spaces. */
  forcePathStyle: boolean;
}

export function s3ObjectStore(cfg: S3StoreConfig): ObjectStore & { ensureBucket(): Promise<void> } {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // Presigned PUTs can't carry a body checksum the SDK computes up front (it would hash an empty
    // body and the real upload would fail it); S3-compatibles like Spaces don't need one.
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  return {
    async presignPut({ key, contentType, contentLength, expiresSeconds }) {
      const cmd = new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: contentType, ContentLength: contentLength });
      const url = await getSignedUrl(client, cmd, { expiresIn: expiresSeconds, signableHeaders: new Set(["content-type", "content-length"]) });
      return {
        url,
        method: "PUT",
        headers: { "content-type": contentType, "content-length": String(contentLength) },
        expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(),
      };
    },
    async presignGet({ key, expiresSeconds }) {
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn: expiresSeconds });
      return { url, expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString() };
    },
    async head(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return { bytes: out.ContentLength ?? 0 };
      } catch (err) {
        if (statusOf(err) === 404) return null;
        throw err;
      }
    },
    async read(key) {
      const out = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      return out.Body!.transformToByteArray();
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },
    /** Local dev convenience: create the bucket if it doesn't exist. Production buckets are provisioned. */
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
      } catch (err) {
        const status = statusOf(err);
        if (status !== 404 && status !== 403) throw err;
        await client.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
      }
    },
  };
}

/** The store configured by env (S3_* vars). Throws when a required var is missing — fail at boot, not at upload. */
export function objectStoreFromEnv() {
  const need = (name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  return s3ObjectStore({
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: need("S3_BUCKET"),
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });
}
