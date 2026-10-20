import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPartyConfig, setPartyConfig } from "@contestly/db";
import { adminPartyLimitsSchema } from "@contestly/shared";
import { requireUser } from "../auth.js";

/**
 * The admin console's settings. Until admin auth exists these only answer with AUTH_MODE=dev (any dev user);
 * with real sign-in they refuse everyone, so they can never ship open.
 */
function requireAdmin(req: FastifyRequest) {
  if ((process.env.AUTH_MODE ?? "dev") !== "dev") throw Object.assign(new Error("admin_only"), { statusCode: 403 });
  return requireUser(req);
}

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
