import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { resolveUser, Unauthorized, type Session } from "@contestly/auth";
import { SIGN_UP_REQUIRED } from "@contestly/shared";
import type { User } from "@contestly/db";

declare module "fastify" {
  interface FastifyRequest { auth?: Session; }
}

export const authPlugin = fp(async (app) => {
  app.decorateRequest("auth", undefined);
  app.addHook("preHandler", async (req) => {
    // Public routes opt out by not calling require*(); we still try to resolve so /parties can personalise.
    try {
      req.auth = await resolveUser({ authorization: req.headers.authorization, devUser: req.headers["x-dev-user"] as string | undefined });
    } catch (e) {
      if (!(e instanceof Unauthorized)) throw e;
    }
  });
});

const signUpRequired = () => Object.assign(new Error(SIGN_UP_REQUIRED), { statusCode: 403 });

/** Anyone with a session, guests included: onboarding, sign-in, free parties, Climb runs. */
export function requireSession(req: FastifyRequest): User {
  if (!req.auth) throw new Unauthorized();
  return req.auth.user;
}

/** A signed-up account. Guests are refused with sign_up_required (money, boards, profiles, hosting). */
export function requireUser(req: FastifyRequest): User {
  const user = requireSession(req);
  if (user.isGuest) throw signUpRequired();
  return user;
}

/**
 * The admin console: an account with the admin role (users.is_admin; ADMIN_EMAILS grants it). With
 * AUTH_MODE=dev, any x-dev-user also passes, so the sims and local console work without sign-in.
 */
export function requireAdmin(req: FastifyRequest): User {
  const user = requireUser(req);
  if (user.isAdmin || req.auth!.via === "dev") return user;
  throw Object.assign(new Error("admin_only"), { statusCode: 403 });
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
