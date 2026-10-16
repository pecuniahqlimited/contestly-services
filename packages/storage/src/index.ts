/**
 * Object storage behind a small vendor-neutral interface. Clients upload straight to storage via
 * presigned URLs (never through the API); services read objects back by key. The S3 implementation
 * covers DO Spaces in production and SeaweedFS locally; tests pass an in-memory fake. No AWS SDK
 * type leaves this file.
 */
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface PresignedUpload {
  url: string;
  method: "PUT";
  /** Headers the client must send with the upload, exactly as given (they're part of the signature). */
  headers: Record<string, string>;
  expiresAt: string;
}

/** The key doesn't exist (e.g. the client never completed its upload). */
export class ObjectNotFound extends Error {}

export interface ObjectStore {
  presignPut(input: { key: string; contentType: string; contentLength: number; expiresSeconds: number }): Promise<PresignedUpload>;
  get(key: string): Promise<Uint8Array>;
}

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
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
        if (!res.Body) throw new ObjectNotFound(`object ${key} has no body`);
        return await res.Body.transformToByteArray();
      } catch (err) {
        if ((err as { name?: string }).name === "NoSuchKey") throw new ObjectNotFound(`object ${key} not found`);
        throw err;
      }
    },
    /** Local dev convenience: create the bucket if it doesn't exist. Production buckets are provisioned. */
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
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
