import type { FastifyInstance } from "fastify";
import { getSocialConfig } from "@contestly/db";
import type { PublicConfig, PublicEnvConfig } from "@contestly/shared";

/**
 * Public: no session needed (the app shows support contacts on sign-in trouble, and in Me). The social
 * numbers come from the admin's config on each request, so an edit reaches the app without a deploy.
 */
export async function configRoutes(app: FastifyInstance, opts: { config: PublicEnvConfig }) {
  app.get("/config", async (): Promise<PublicConfig> => {
    const { cornerPostMaxChars, yourPeopleDays } = await getSocialConfig();
    return { ...opts.config, social: { cornerPostMaxChars, yourPeopleDays } };
  });
}
