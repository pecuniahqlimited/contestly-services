import type { FastifyInstance } from "fastify";
import type { PublicConfig } from "@contestly/shared";

/** Public: no session needed (the app shows support contacts on sign-in trouble, and in Me). */
export async function configRoutes(app: FastifyInstance, opts: { config: PublicConfig }) {
  app.get("/config", async () => opts.config);
}
