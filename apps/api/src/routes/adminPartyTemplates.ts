import type { FastifyInstance } from "fastify";
import { clearHeldPrize, currentPartyTemplates, db, recordAdminAction, rejectHeldPrize, savePartyTemplates } from "@contestly/db";
import {
  adminHeldPrizesQuerySchema, adminHeldPrizesResponseSchema, adminPartyTemplatePreviewResponseSchema, adminPartyTemplatePreviewSchema, adminPartyTemplatesBodySchema,
  heldPrizeDecisionResponseSchema, heldPrizeDecisionSchema, maxHostQuestions, partyTemplatesConfigSchema, partyTemplatesVersionSchema, templatePrefill, templateProblems,
} from "@contestly/shared";
import { requireAdmin, uuidParam } from "../auth.js";
import { httpError } from "../httpError.js";
import { heldPrizeView, listHeldPrizes } from "../heldPrizes.js";
import { templatesVersionView } from "../partyTemplates.js";

/** Party templates and the held-prize queue (ADR 0015). Every write is logged with a reason. */
export async function adminPartyTemplatesRoutes(app: FastifyInstance) {
  /** The whole config, current version: templates in order (hidden ones too) and the host-written rules. */
  app.get("/admin/party-templates", async (req) => {
    requireAdmin(req);
    return partyTemplatesVersionSchema.parse(templatesVersionView(await currentPartyTemplates()));
  });

  /**
   * Save a new version: add, edit, reorder, hide or remove templates, or change the rules. New parties use it from
   * now on; parties already made keep their copy of the template and the rules they were made under.
   */
  app.put("/admin/party-templates", async (req) => {
    const admin = requireAdmin(req);
    const { config, reason } = adminPartyTemplatesBodySchema.parse(req.body);
    const saved = await db.transaction(async (tx) => {
      const before = await currentPartyTemplates(tx);
      const row = await savePartyTemplates(tx, config, admin.id);
      await recordAdminAction(tx, { adminUserId: admin.id, action: "config.party_templates", targetType: "config", targetId: "party_templates", reason, before: { version: before.version, config: before.config }, after: { version: row.version, config: row.config } });
      return row;
    });
    return partyTemplatesVersionSchema.parse(templatesVersionView(saved));
  });

  /** What a party made from one template would start as, against the current config or a draft not saved yet. */
  app.post("/admin/party-templates/preview", async (req) => {
    requireAdmin(req);
    const { templateId, config: draft } = adminPartyTemplatePreviewSchema.parse(req.body);
    const config = draft === undefined ? (await currentPartyTemplates()).config : partyTemplatesConfigSchema.parse(draft);
    const template = config.templates.find((t) => t.id === templateId);
    if (!template) throw httpError(404, "template_not_found");
    return adminPartyTemplatePreviewResponseSchema.parse({
      template, prefill: templatePrefill(template), hostQuestionsAllowed: maxHostQuestions(template.dials.questionCount, config.rules), problems: templateProblems(template, config.rules),
    });
  });

  /** Held template prizes with their evidence; ?status=held for the queue. */
  app.get("/admin/party-templates/held-prizes", async (req) => {
    requireAdmin(req);
    return adminHeldPrizesResponseSchema.parse({ prizes: await listHeldPrizes(adminHeldPrizesQuerySchema.parse(req.query)) });
  });

  /**
   * Clear: the prize moves from the winner's hold into their cash. Two admins, whatever the amount: the first one's
   * clear asks (awaitingSecondAdmin) and a different admin's clear confirms. Never the host or the winner. With a
   * reason, logged.
   */
  app.post("/admin/party-templates/held-prizes/:id/clear", async (req) => {
    const admin = requireAdmin(req);
    const { reason } = heldPrizeDecisionSchema.parse(req.body);
    const { row, replayed, awaitingSecondAdmin } = await clearHeldPrize(admin.id, uuidParam(req), reason);
    return heldPrizeDecisionResponseSchema.parse({ prize: await heldPrizeView(row), replayed, awaitingSecondAdmin });
  });

  /**
   * Reject: the prize is taken back and passed on by the rule (ADR 0015's implementation notes). Two admins, as for
   * a clear. Never the host or the winner. With a reason, logged.
   */
  app.post("/admin/party-templates/held-prizes/:id/reject", async (req) => {
    const admin = requireAdmin(req);
    const { reason } = heldPrizeDecisionSchema.parse(req.body);
    const { row, replayed, awaitingSecondAdmin } = await rejectHeldPrize(admin.id, uuidParam(req), reason);
    return heldPrizeDecisionResponseSchema.parse({ prize: await heldPrizeView(row), replayed, awaitingSecondAdmin });
  });
}
