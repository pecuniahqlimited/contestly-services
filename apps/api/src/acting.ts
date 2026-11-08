/**
 * Acting as a brand (ADR 0017 §2): the active profile is the ACT_AS_HEADER, per request. A route opts in with the
 * capability it needs (`{ config: { actAs: "wallet.view" } }`) and reads who it acts for with actor(); any other
 * route called with the header is refused (deny by default), so a brand can never join, climb or crew.
 */
import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { assertBrandCan, db, type Acting, type User } from "@contestly/db";
import { ACT_AS_HEADER, NOT_AVAILABLE_AS_BRAND, type BrandCapability } from "@contestly/shared";
import { requireSession, requireUser } from "./auth.js";
import { httpError } from "./httpError.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** This route can be used as a brand by a team member whose role grants this capability. */
    actAs?: BrandCapability;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The brand id the request acts as, or null for the person themselves. A malformed id is a 400. */
export function actAsHeader(req: FastifyRequest): string | null {
  const raw = req.headers[ACT_AS_HEADER];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v?.trim()) return null;
  if (!UUID.test(v.trim())) throw httpError(400, `invalid ${ACT_AS_HEADER}`);
  return v.trim().toLowerCase();
}

/** Registered before the routes: the header on a route that didn't opt in is refused before its handler runs. */
export const actingPlugin = fp(async (app) => {
  app.addHook("preHandler", async (req) => {
    if (actAsHeader(req) && !req.routeOptions.config?.actAs) throw httpError(400, NOT_AVAILABLE_AS_BRAND);
  });
});

export interface Actor {
  /** The signed-in person (always: the one the session belongs to). */
  person: User;
  /** Who the request acts as: the brand's account, or the person. */
  as: User;
  /** Set when acting as a brand: its row and the person's role. */
  brand: Acting | null;
}

/**
 * Who this request acts for, under the route's capability (or `capability`, for a route that needs a different one
 * on some branch). A signed-up person always; the brand they act as when the header is sent and their role allows it
 * (404 not_a_member, 403 brand_role_forbidden otherwise).
 */
export async function actor(req: FastifyRequest, capability?: BrandCapability): Promise<Actor> {
  const person = requireUser(req);
  const brandId = actAsHeader(req);
  if (!brandId) return { person, as: person, brand: null };
  const needed = capability ?? req.routeOptions.config?.actAs;
  if (!needed) throw httpError(400, NOT_AVAILABLE_AS_BRAND);
  const brand = await assertBrandCan(db, brandId, person, needed);
  return { person, as: brand.account, brand };
}

/** A route guests can use too (their party's chat): the session as usual, or the brand when the header is sent. */
export async function sessionOrBrand(req: FastifyRequest): Promise<User> {
  return actAsHeader(req) ? (await actor(req)).as : requireSession(req);
}
