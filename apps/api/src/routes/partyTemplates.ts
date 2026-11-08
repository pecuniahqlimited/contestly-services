import type { FastifyInstance } from "fastify";
import { distractorRequestSchema, hostQuestionSchema } from "@contestly/shared";
import { curateHostType, prospectiveHost } from "@contestly/db";
import { actAsHeader, actor } from "../acting.js";
import { optionalSession, requireUser, uuidParam } from "../auth.js";
import { addHostQuestion, editHostQuestion, removeHostQuestion } from "../hostQuestions.js";
import { assertHostTextSafe } from "../distractors.js";
import { offeredTemplates } from "../partyTemplates.js";

/** A suggestion is a generation call; a host filling in a template's prompts has no reason to ask for many a minute. */
const DISTRACTORS_PER_MINUTE = 30;

/** Templates for the builder and host-written questions (ADR 0015). The logic is in partyTemplates.ts and hostQuestions.ts. */
export async function partyTemplatesRoutes(app: FastifyInstance) {
  /** The occasions the builder offers now, in order, and the asking host's curate caps (a person's without a session). */
  app.get("/party-templates", { config: { actAs: "parties.host" } }, async (req) => {
    // As a brand (ADR 0017): a verified brand's caps.
    if (actAsHeader(req)) return offeredTemplates(curateHostType((await actor(req)).as));
    const me = optionalSession(req);
    return offeredTemplates(me ? curateHostType(await prospectiveHost(me.id)) : "person");
  });

  /** Three believable wrong answers for the host's question, through the questions service (no party needed yet). */
  app.post("/parties/host-questions/distractors", { config: { rateLimit: { max: DISTRACTORS_PER_MINUTE, timeWindow: "1 minute" } } }, async (req) => {
    requireUser(req);
    const ask = distractorRequestSchema.parse(req.body);
    // The host's own words first, failing closed: an unsafe question never reaches the questions service.
    assertHostTextSafe({ question: ask.question, answer: ask.answer }, ask.brief);
    return app.distractors(ask);
  });

  /** Add one to an open curate party (host's team). */
  app.post("/parties/:id/host-questions", async (req, reply) => {
    return reply.code(201).send(await addHostQuestion(uuidParam(req), requireUser(req), hostQuestionSchema.parse(req.body)));
  });
  app.put("/parties/:id/host-questions/:qid", async (req, reply) => {
    await editHostQuestion(uuidParam(req), uuidParam(req, "qid"), requireUser(req), hostQuestionSchema.parse(req.body));
    return reply.code(204).send();
  });
  app.delete("/parties/:id/host-questions/:qid", async (req, reply) => {
    await removeHostQuestion(uuidParam(req), uuidParam(req, "qid"), requireUser(req));
    return reply.code(204).send();
  });
}
