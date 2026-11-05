import type { FastifyInstance } from "fastify";
import { blockUser, blocksOf, fileReport, markNoticeSeen, muteUser, unblockUser, unmuteUser, unseenNotices } from "@contestly/db";
import {
  REPORT_REASONS, blockResponseSchema, cornerReportBodySchema, muteResponseSchema, myBlocksSchema, reportBodySchema, reportResponseSchema, userNoticesSchema,
  type ReportBody, type ReportReason,
} from "@contestly/shared";
import { requireSession, uuidParam } from "../auth.js";
import { limit } from "../redis.js";
import { peopleHidden, publishSafety } from "../safetyEvents.js";

/**
 * Trust and safety for people (ADR 0014): block, mute, report, and the notices the app shows once. Guests can
 * block, mute and report too: they meet strangers in free parties.
 */
export async function safetyRoutes(app: FastifyInstance) {
  /** Block: mutual in effect, silent (they aren't told). */
  app.post("/users/:id/block", async (req) => {
    const me = requireSession(req);
    const id = uuidParam(req);
    const out = await blockUser(me, id);
    await peopleHidden(me.id, id);
    return blockResponseSchema.parse(out);
  });
  app.delete("/users/:id/block", async (req) => {
    const me = requireSession(req);
    const id = uuidParam(req);
    const out = await unblockUser(me, id);
    await peopleHidden(me.id, id);
    return blockResponseSchema.parse(out);
  });
  app.get("/me/blocks", async (req) => {
    const rows = await blocksOf(requireSession(req).id);
    return myBlocksSchema.parse({ blocks: rows.map(({ at, ...person }) => ({ person, blockedAt: at.toISOString() })) });
  });

  /** Mute: their chat lines and nudges about them stop reaching you. Nothing else changes. */
  app.post("/users/:id/mute", async (req) => {
    const me = requireSession(req);
    const id = uuidParam(req);
    const out = await muteUser(me, id);
    await peopleHidden(me.id);
    return muteResponseSchema.parse(out);
  });
  app.delete("/users/:id/mute", async (req) => {
    const me = requireSession(req);
    const out = await unmuteUser(me, uuidParam(req));
    await peopleHidden(me.id);
    return muteResponseSchema.parse(out);
  });

  const report = async (me: { id: string }, body: ReportBody) => {
    await limit("report", me.id, app.limits.reportsPerHour, 3600);
    const out = await fileReport(me, body);
    await publishSafety(out.events);
    return out;
  };

  /** Report a person, a chat line, a corner post or reply, a party or a voice note. 201, or 200 when you'd reported it already. */
  app.post("/reports", async (req, reply) => {
    const out = await report(requireSession(req), reportBodySchema.parse(req.body));
    return reply.code(out.replayed ? 200 : 201).send(reportResponseSchema.parse(out));
  });

  /** The corner reply report from 6c: now POST /reports. A free-text reason that isn't one of the fixed ones becomes "other" with it as the note. */
  app.post("/corner-replies/:id/report", async (req, reply) => {
    const said = cornerReportBodySchema.parse(req.body ?? {}).reason;
    const known = (REPORT_REASONS as readonly string[]).includes(said ?? "");
    const body: ReportBody = { target: { type: "corner_reply", id: uuidParam(req) }, reason: known ? (said as ReportReason) : "other", note: known ? undefined : said || "reported from a corner" };
    const out = await report(requireSession(req), body);
    return reply.code(out.replayed ? 200 : 201).send({ reported: true, ...reportResponseSchema.parse(out) });
  });

  /** A warning, or what came of your report: shown once, then marked seen. */
  app.get("/me/notices", async (req) => userNoticesSchema.parse({ notices: await unseenNotices(requireSession(req).id) }));
  app.post("/me/notices/:id/seen", async (req) => markNoticeSeen(requireSession(req).id, uuidParam(req)));
}
