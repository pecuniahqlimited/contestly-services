/**
 * DEV ONLY, one-off: party source files used to be uploaded to object storage (step 2b's presigned path).
 * They're now read in the API and never stored (ADR 0004), so the copies left in a local bucket under
 * parties/<id>/files/ are deleted here. Lists what it finds; deletes only with --delete. Nothing else in the
 * bucket (media) is touched.
 *
 *   npx tsx --env-file=.env scripts/purge-source-files.ts            list
 *   npx tsx --env-file=.env scripts/purge-source-files.ts --delete   list, then delete
 */
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

if (process.env.NODE_ENV === "production") {
  console.error("purge-source-files is for local buckets only.");
  process.exit(1);
}

const SOURCE_FILE_KEY = /^parties\/[0-9a-f-]{36}\/files\//;
/** S3 deletes at most this many keys per request. */
const DELETE_BATCH = 1000;

const bucket = process.env.S3_BUCKET!;
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT || undefined,
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
});

const keys: string[] = [];
let token: string | undefined;
do {
  const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "parties/", ContinuationToken: token }));
  for (const o of page.Contents ?? []) if (o.Key && SOURCE_FILE_KEY.test(o.Key)) keys.push(o.Key);
  token = page.NextContinuationToken;
} while (token);

for (const k of keys) console.log(k);
console.log(`${keys.length} source file(s) in ${bucket}.`);
if (!process.argv.includes("--delete") || !keys.length) process.exit(0);

for (let i = 0; i < keys.length; i += DELETE_BATCH) {
  const batch = keys.slice(i, i + DELETE_BATCH);
  const res = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((Key) => ({ Key })) } }));
  if (res.Errors?.length) throw new Error(`couldn't delete: ${res.Errors.map((e) => `${e.Key} (${e.Message})`).join(", ")}`);
}
console.log(`Deleted ${keys.length}.`);
