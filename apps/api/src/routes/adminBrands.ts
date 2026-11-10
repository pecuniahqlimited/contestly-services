/**
 * Brands in the admin console (ADR 0017): the list (and the review queue: ?status=in_review, longest waiting first),
 * one brand with its checklist, team, history and wallet (its ledger is the account's: /admin/users/:id/ledger),
 * the review decisions, and the queue of verified brands' new logos with its approve and reject; each decision is
 * logged with its reason.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  approveBrand, approveBrandLogo, brandEvents, pendingLogos, rejectBrandLogo, brandMembers, brands, checklistOf, db, hasPayoutAccount, ledger, ownerOf, payoutAccounts, requestBrandChanges, reviewQueueOrder, teamOf, users,
  type Brand, type User,
} from "@contestly/db";
import {
  adminBrandApproveResponseSchema, adminBrandChangesResponseSchema, adminBrandDecisionSchema, adminBrandDetailSchema, adminBrandLogoDecisionResponseSchema, adminBrandLogoDecisionSchema,
  adminBrandLogosQuerySchema, adminBrandLogosResponseSchema, adminBrandsQuerySchema, adminBrandsResponseSchema,
} from "@contestly/shared";
import { requireAdmin, uuidParam } from "../auth.js";
import { httpError } from "../httpError.js";
import { inviteView, memberView, pendingLogoView, personView, settingsView, verificationView } from "../brands.js";
import { imageUrl, removeImages } from "../images.js";

const EVENTS_SHOWN = 100;
const iso = (d: Date | null) => d?.toISOString() ?? null;

async function rowView(account: User, brand: Brand) {
  const [owner, [size], payout] = await Promise.all([
    ownerOf(db, account.id),
    db.select({ n: sql<number>`count(*)::int` }).from(brandMembers).where(eq(brandMembers.brandId, account.id)),
    hasPayoutAccount(db, account.id),
  ]);
  return {
    id: account.id, handle: account.archivedHandle ?? account.handle, displayName: account.archivedDisplayName ?? account.displayName, avatarEmoji: account.avatarEmoji,
    owner: owner ? personView(owner) : null, teamSize: Number(size.n), verification: verificationView(brand), checklist: checklistOf(brand, payout),
    bannedAt: iso(account.bannedAt), deletedAt: iso(account.deletedAt), createdAt: brand.createdAt.toISOString(),
  };
}

export async function adminBrandsRoutes(app: FastifyInstance) {
  app.get("/admin/brands", async (req) => {
    requireAdmin(req);
    const q = adminBrandsQuerySchema.parse(req.query ?? {});
    const where: SQL[] = [];
    if (q.status) where.push(eq(brands.verificationStatus, q.status));
    if (q.q) where.push(or(ilike(users.handle, `${q.q}%`), ilike(users.displayName, `%${q.q}%`), ilike(users.archivedHandle, `${q.q}%`))!);
    // The review queue reads oldest submission first; everything else newest brand first.
    const order = q.status === "in_review" ? [reviewQueueOrder] : [desc(brands.createdAt)];
    const rows = await db.select({ account: users, brand: brands }).from(brands).innerJoin(users, eq(users.id, brands.id))
      .where(where.length ? and(...where) : undefined).orderBy(...order, asc(brands.id)).limit(q.limit);
    return adminBrandsResponseSchema.parse({ brands: await Promise.all(rows.map((r) => rowView(r.account, r.brand))) });
  });

  /** Verified brands' new logos waiting, longest first, each beside the live one. */
  app.get("/admin/brands/logos", async (req) => {
    requireAdmin(req);
    const q = adminBrandLogosQuerySchema.parse(req.query ?? {});
    const rows = await pendingLogos(q.limit);
    const senderIds = [...new Set(rows.map((r) => r.brand.pendingLogoByUserId).filter((x): x is string => !!x))];
    const senders = new Map((senderIds.length ? await db.select().from(users).where(inArray(users.id, senderIds)) : []).map((u) => [u.id, personView(u)]));
    return adminBrandLogosResponseSchema.parse({
      logos: await Promise.all(rows.map(async ({ account, brand }) => ({
        brand: personView(account), liveLogoUrl: await imageUrl(brand.logoKey),
        pending: { ...(await pendingLogoView(brand))!, submittedBy: brand.pendingLogoByUserId ? senders.get(brand.pendingLogoByUserId) ?? null : null },
      }))),
    });
  });

  for (const [decision, decide] of [["approve", approveBrandLogo], ["reject", rejectBrandLogo]] as const) {
    /** Decide the logo waiting, named by its key; a rejection's reason is the note the team sees. Logged. */
    app.post(`/admin/brands/:id/logo/${decision}`, async (req) => {
      const admin = requireAdmin(req);
      const { key, reason } = adminBrandLogoDecisionSchema.parse(req.body);
      const { removed, ...answer } = await decide(admin.id, uuidParam(req), key, reason);
      await removeImages(removed, req.log);
      return adminBrandLogoDecisionResponseSchema.parse(answer);
    });
  }

  app.get("/admin/brands/:id", async (req) => {
    requireAdmin(req);
    const id = uuidParam(req);
    const [row] = await db.select({ account: users, brand: brands }).from(brands).innerJoin(users, eq(users.id, brands.id)).where(eq(brands.id, id));
    if (!row) throw httpError(404, "not_found");
    const [base, settings, team, events, balances, payouts] = await Promise.all([
      rowView(row.account, row.brand),
      settingsView(row.account, row.brand, "owner"),
      teamOf(id),
      db.select().from(brandEvents).where(eq(brandEvents.brandId, id)).orderBy(desc(brandEvents.createdAt)).limit(EVENTS_SHOWN),
      ledger.balances(id),
      db.select({ n: sql<number>`count(*)::int` }).from(payoutAccounts).where(eq(payoutAccounts.userId, id)),
    ]);
    const ids = [...new Set(events.flatMap((e) => [e.actorUserId, e.subjectUserId]).filter((x): x is string => !!x))];
    const people = new Map((ids.length ? await db.select().from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, personView(u)]));
    const { role: _role, ...brand } = settings;
    return adminBrandDetailSchema.parse({
      ...base, brand, members: team.members.map(memberView), invites: team.invites.map((i) => inviteView(i, team.people)),
      events: events.map((e) => ({ id: e.id, kind: e.kind, actor: e.actorUserId ? people.get(e.actorUserId) ?? null : null, subject: e.subjectUserId ? people.get(e.subjectUserId) ?? null : null, detail: e.detail, createdAt: e.createdAt.toISOString() })),
      wallet: { cashKobo: balances.cashKobo, bonusKobo: balances.bonusKobo, payoutAccounts: Number(payouts[0].n) },
    });
  });

  /** Approve a brand in review: verified, its corner opens, its owner and admins are told. The reason is logged. */
  app.post("/admin/brands/:id/approve", async (req) => {
    const admin = requireAdmin(req);
    return adminBrandApproveResponseSchema.parse(await approveBrand(admin.id, uuidParam(req), adminBrandDecisionSchema.parse(req.body).reason));
  });

  /** Send it back with a note the brand's team sees (a verified brand is unverified until approved again). */
  app.post("/admin/brands/:id/request-changes", async (req) => {
    const admin = requireAdmin(req);
    return adminBrandChangesResponseSchema.parse(await requestBrandChanges(admin.id, uuidParam(req), adminBrandDecisionSchema.parse(req.body).reason));
  });
}
