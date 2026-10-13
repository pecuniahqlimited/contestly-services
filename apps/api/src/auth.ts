import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { resolveUser, Unauthorized } from "@contestly/auth";
import type { User } from "@contestly/db";

declare module "fastify" {
  interface FastifyRequest { auth?: Awaited<ReturnType<typeof resolveUser>>; }
}

export const authPlugin = fp(async (app) => {
  app.decorateRequest("auth", undefined);
  app.addHook("preHandler", async (req) => {
    // Public routes opt out by not calling requireUser(); we still try to resolve so /parties can personalise.
    try {
      req.auth = await resolveUser({ authorization: req.headers.authorization, devUser: req.headers["x-dev-user"] as string | undefined });
    } catch (e) {
      if (!(e instanceof Unauthorized)) throw e;
    }
  });
});

/** Use inside handlers that need a signed-in, onboarded user. */
export function requireUser(req: FastifyRequest): User {
  if (!req.auth) throw new Unauthorized();
  if (!req.auth.user) throw new Unauthorized("complete onboarding first (POST /me)");
  return req.auth.user;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Reads :id from the route and rejects anything that isn't a UUID with a 400 instead of a database error. */
export function uuidParam(req: FastifyRequest, name = "id"): string {
  const v = (req.params as Record<string, string>)[name];
  if (!v || !UUID.test(v)) throw Object.assign(new Error(`invalid ${name}`), { statusCode: 400 });
  return v;
}
