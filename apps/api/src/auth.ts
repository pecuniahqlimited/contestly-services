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

/**
 * The admin console. Until admin auth exists this only lets anyone through with AUTH_MODE=dev (any dev user);
 * with real sign-in it refuses everyone, so admin routes can never ship open.
 */
export function requireAdmin(req: FastifyRequest): User {
  if ((process.env.AUTH_MODE ?? "dev") !== "dev") throw Object.assign(new Error("admin_only"), { statusCode: 403 });
  return requireUser(req);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Reads a YYYY-MM-DD route param (a Climb day) and rejects anything else with a 400. */
export function dayParam(req: FastifyRequest, name = "day"): string {
  const v = (req.params as Record<string, string>)[name];
  if (!v || !DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw Object.assign(new Error(`invalid ${name}`), { statusCode: 400 });
  }
  return v;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Reads :id from the route and rejects anything that isn't a UUID with a 400 instead of a database error. */
export function uuidParam(req: FastifyRequest, name = "id"): string {
  const v = (req.params as Record<string, string>)[name];
  if (!v || !UUID.test(v)) throw Object.assign(new Error(`invalid ${name}`), { statusCode: 400 });
  return v;
}
