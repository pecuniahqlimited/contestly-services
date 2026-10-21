import type { FastifyInstance } from "fastify";
import { getPartyConfig, setPartyConfig } from "@contestly/db";
import { adminPartyLimitsSchema } from "@contestly/shared";
import { requireAdmin } from "../auth.js";

export async function adminRoutes(app: FastifyInstance) {
  /** The party limits as stored, quick picks outside their range included (hosts don't see those). */
  app.get("/admin/party-limits", async (req) => {
    requireAdmin(req);
    return { limits: (await getPartyConfig()).limits };
  });

  /** New parties use these from now on; parties already created keep the limits they were made with. */
  app.put("/admin/party-limits", async (req) => {
    requireAdmin(req);
    const { limits } = adminPartyLimitsSchema.parse(req.body);
    const saved = await setPartyConfig({ ...(await getPartyConfig()), limits });
    return { limits: saved.limits };
  });
}
