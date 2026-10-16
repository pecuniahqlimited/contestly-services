/**
 * Source files for question generation. The client gets a presigned PUT and uploads straight to
 * object storage (never through the API), then tells us it's done; the questions service parses
 * and chunks it. Only the host's team, only while the party is open.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db, parties, partyFiles, isHostTeam, type User } from "@contestly/db";
import { questionsQueue } from "@contestly/queue";
import { objectStoreFromEnv, type PresignedUpload } from "@contestly/storage";

const UPLOAD_URL_TTL_SECONDS = 15 * 60;

const store = objectStoreFromEnv();
const questionJobs = questionsQueue();
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

async function hostParty(partyId: string, user: User) {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!p) throw httpError(404, "not_found");
  if (!isHostTeam(p, user.id)) throw httpError(403, "host_team_only");
  return p;
}

/** Keys never carry the user's filename verbatim — only a tame slug of it. */
const slug = (filename: string) => filename.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "file";

export async function requestUpload(partyId: string, user: User, file: { filename: string; contentType: string; sizeBytes: number }): Promise<{ fileId: string; upload: PresignedUpload }> {
  const p = await hostParty(partyId, user);
  if (p.status !== "open") throw httpError(409, "party_not_open");
  const fileId = randomUUID();
  const storageKey = `parties/${partyId}/files/${fileId}/${slug(file.filename)}`;
  await db.insert(partyFiles).values({ id: fileId, partyId, uploaderId: user.id, storageKey, filename: file.filename, contentType: file.contentType, sizeBytes: file.sizeBytes });
  const upload = await store.presignPut({ key: storageKey, contentType: file.contentType, contentLength: file.sizeBytes, expiresSeconds: UPLOAD_URL_TTL_SECONDS });
  return { fileId, upload };
}

/** The client finished its PUT: hand the file to the questions service. */
export async function ingestUpload(partyId: string, fileId: string, user: User): Promise<void> {
  await hostParty(partyId, user);
  const [f] = await db.update(partyFiles).set({ status: "parsing" })
    .where(and(eq(partyFiles.id, fileId), eq(partyFiles.partyId, partyId), eq(partyFiles.status, "uploading"))).returning();
  if (!f) throw httpError(409, "file_not_awaiting_ingest");
  await questionJobs.add("parse_file", { kind: "parse_file", fileId }, { jobId: `parse-file-${fileId}` });
}

export async function listFiles(partyId: string, user: User) {
  await hostParty(partyId, user);
  return db.select({ id: partyFiles.id, filename: partyFiles.filename, contentType: partyFiles.contentType, sizeBytes: partyFiles.sizeBytes, status: partyFiles.status, error: partyFiles.error, createdAt: partyFiles.createdAt })
    .from(partyFiles).where(eq(partyFiles.partyId, partyId)).orderBy(asc(partyFiles.createdAt));
}
