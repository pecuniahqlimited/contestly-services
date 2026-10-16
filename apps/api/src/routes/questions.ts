import type { FastifyInstance } from "fastify";
import { editDraftSchema, requestUploadSchema } from "@contestly/shared";
import { requireUser, uuidParam } from "../auth.js";
import { approveDraft, editDraft, listDrafts, requestDrafts, requestRegenerate, swapDraft } from "../drafts.js";
import { ingestUpload, listFiles, requestUpload } from "../files.js";

/** Source files and curate-mode review. Host's team only; the logic lives in files.ts and drafts.ts. */
export async function questionsRoutes(app: FastifyInstance) {
  app.post("/parties/:id/files", async (req, reply) => {
    const res = await requestUpload(uuidParam(req), requireUser(req), requestUploadSchema.parse(req.body));
    return reply.code(201).send(res);
  });
  app.post("/parties/:id/files/:fileId/ingest", async (req, reply) => {
    await ingestUpload(uuidParam(req), uuidParam(req, "fileId"), requireUser(req));
    return reply.code(202).send({ status: "parsing" });
  });
  app.get("/parties/:id/files", async (req) => listFiles(uuidParam(req), requireUser(req)));

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
