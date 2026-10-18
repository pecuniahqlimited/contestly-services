import type { FastifyInstance } from "fastify";
import { MAX_UPLOAD_BYTES, SOURCE_FILE_FIELD, editDraftSchema, retryQuestionsSchema } from "@contestly/shared";
import { retrySealedSet } from "../questionSet.js";
import { requireUser, uuidParam } from "../auth.js";
import { approveDraft, editDraft, listDrafts, requestDrafts, requestRegenerate, swapDraft } from "../drafts.js";
import { assertCanSendSource, isUploadContentType, listFiles, replaceSource } from "../files.js";

/** Reading a file is real work; a host has no reason to send many in a minute. */
const SOURCE_SENDS_PER_MINUTE = 10;
const TOO_LARGE = 413;

/** Source files, sealed-set retries and curate-mode review. Host's team only; the logic lives in files.ts, questionSet.ts and drafts.ts. */
export async function questionsRoutes(app: FastifyInstance) {
  /** The party's source file, as multipart (field SOURCE_FILE_FIELD). Replaces any file before it; the bytes are read, never kept. */
  app.put("/parties/:id/files", { config: { rateLimit: { max: SOURCE_SENDS_PER_MINUTE, timeWindow: "1 minute" } } }, async (req, reply) => {
    const partyId = uuidParam(req);
    const user = requireUser(req);
    await assertCanSendSource(partyId, user);
    // One byte past the cap: busboy doesn't always throw when it cuts a file off at its limit, so a file
    // that reaches this length was over the cap, never a whole file to read.
    const part = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES + 1, files: 1 } });
    if (!part || part.fieldname !== SOURCE_FILE_FIELD) return reply.code(400).send({ error: `send the file as the "${SOURCE_FILE_FIELD}" field` });
    if (!isUploadContentType(part.mimetype)) return reply.code(415).send({ error: "unsupported_file_type" });
    const bytes = await part.toBuffer().catch((err) => (err.statusCode === TOO_LARGE ? null : Promise.reject(err)));
    if (!bytes || bytes.byteLength > MAX_UPLOAD_BYTES) return reply.code(TOO_LARGE).send({ error: "file_too_large" });
    return reply.code(201).send(await replaceSource(partyId, user, { filename: part.filename, contentType: part.mimetype, bytes }));
  });
  app.get("/parties/:id/files", async (req) => listFiles(uuidParam(req), requireUser(req)));

  /** A sealed set that failed: try again, optionally with a changed brief, difficulty or formats. */
  app.post("/parties/:id/questions/retry", async (req, reply) => {
    await retrySealedSet(uuidParam(req), requireUser(req), retryQuestionsSchema.parse(req.body ?? {}));
    return reply.code(202).send({ status: "generating" });
  });

  app.post("/parties/:id/drafts", async (req, reply) => {
    await requestDrafts(uuidParam(req), requireUser(req));
    return reply.code(202).send({ status: "generating" });
  });
  app.get("/parties/:id/drafts", async (req) => listDrafts(uuidParam(req), requireUser(req)));
  app.post("/parties/:id/drafts/:qid/approve", async (req, reply) => {
    await approveDraft(uuidParam(req), uuidParam(req, "qid"), requireUser(req));
    return reply.code(204).send();
  });
  app.patch("/parties/:id/drafts/:qid", async (req, reply) => {
    await editDraft(uuidParam(req), uuidParam(req, "qid"), requireUser(req), editDraftSchema.parse(req.body));
    return reply.code(204).send();
  });
  app.post("/parties/:id/drafts/:qid/swap", async (req, reply) => {
    await swapDraft(uuidParam(req), uuidParam(req, "qid"), requireUser(req));
    return reply.code(204).send();
  });
  app.post("/parties/:id/drafts/:qid/regenerate", async (req, reply) => {
    await requestRegenerate(uuidParam(req), uuidParam(req, "qid"), requireUser(req));
    return reply.code(202).send({ status: "regenerating" });
  });
}
