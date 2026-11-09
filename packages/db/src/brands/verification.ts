/**
 * Brand verification (ADR 0017 §7): a checklist, submitted for review, approved or sent back with a note by an
 * admin. Approval sets the account's is_verified (what canOfferNonCashPrize and curateHostType read), opens its
 * corner (createBrandCorner) and nudges the owner and admins, all in one transaction with the admin log.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { CAC_NUMBER_RE, type BrandChecklist } from "@contestly/shared";
import { db, type Tx } from "../client.js";
import { brands, payoutAccounts, users, type Brand, type User } from "../schema.js";
import { recordAdminAction } from "../admin.js";
import { createBrandCorner } from "../corners.js";
import { nudge } from "../nudges/record.js";
import { assertBrandCan, brandError, liveBrand, recordBrandEvent, roleIn, teamWith } from "./team.js";

type Conn = Tx | typeof db;

export async function hasPayoutAccount(conn: Conn, accountId: string): Promise<boolean> {
  const [row] = await conn.select({ id: payoutAccounts.id }).from(payoutAccounts).where(and(eq(payoutAccounts.userId, accountId), isNull(payoutAccounts.removedAt))).limit(1);
  return !!row;
}

/** What verification still needs. The payout account counts only when the brand says it will give cash prizes. */
export function checklistOf(brand: Brand, payoutAccount: boolean): BrandChecklist {
  const items = {
    registrationNumber: !!brand.registrationNumber && CAC_NUMBER_RE.test(brand.registrationNumber),
    logo: !!brand.logoKey,
    link: !!brand.siteUrl || Object.values(brand.socials ?? {}).some(Boolean),
    businessEmail: !!brand.businessEmail && !!brand.businessEmailVerifiedAt,
    payoutAccount: (!brand.cashPrizes ? "not_needed" : payoutAccount ? "done" : "missing") as BrandChecklist["payoutAccount"],
  };
  const complete = items.registrationNumber && items.logo && items.link && items.businessEmail && items.payoutAccount !== "missing";
  return { ...items, complete };
}

export async function checklistFor(conn: Conn, brand: Brand) {
  return checklistOf(brand, await hasPayoutAccount(conn, brand.id));
}

/** The business email, once its code checked out (the API checks it). A verified brand's is locked. */
export async function setBusinessEmail(brandId: string, person: User, email: string): Promise<void> {
  await db.transaction(async (tx) => {
    const { brand } = await assertBrandCan(tx, brandId, person, "settings");
    if (brand.verificationStatus === "verified" && brand.businessEmail !== email) throw brandError(409, "brand_email_locked");
    await tx.update(brands).set({ businessEmail: email, businessEmailVerifiedAt: new Date() }).where(eq(brands.id, brandId));
    await recordBrandEvent(tx, { brandId, kind: "business_email_verified", actorUserId: person.id, detail: { email } });
  });
}

/** Send for review (settings capability): from draft or changes needed, with the checklist complete. */
export async function submitForReview(brandId: string, person: User): Promise<{ status: "in_review"; replayed: boolean }> {
  return db.transaction(async (tx) => {
    const { brand } = await assertBrandCan(tx, brandId, person, "settings");
    const [locked] = await tx.select().from(brands).where(eq(brands.id, brand.id)).for("update");
    if (locked.verificationStatus === "in_review") return { status: "in_review", replayed: true };
    if (locked.verificationStatus === "verified") throw brandError(409, "already_verified");
    const checklist = await checklistFor(tx, locked);
    if (!checklist.complete) throw brandError(422, "checklist_incomplete", { checklist });
    await tx.update(brands).set({ verificationStatus: "in_review", submittedAt: new Date() }).where(eq(brands.id, brandId));
    await recordBrandEvent(tx, { brandId, kind: "submitted", actorUserId: person.id, detail: { checklist } });
    return { status: "in_review", replayed: false };
  });
}

/** The owner and admins hear how the review went (verification_update), in the decision's transaction. */
async function tellTeam(tx: Tx, account: User, outcome: "approved" | "changes_needed", decidedAt: Date) {
  for (const userId of await teamWith(tx, account.id, "settings")) {
    await nudge(tx, {
      userId, kind: "verification_update", data: { brandId: account.id, brandName: account.displayName, outcome },
      ref: { type: "brand", id: account.id }, dedupeKey: `verification_update:${account.id}:${decidedAt.getTime()}:${userId}`,
    });
  }
}

/** No admin decides a brand they're on the team of (the same rule as held prizes, ADR 0015): 403 own_brand. */
async function assertNoInterest(tx: Tx, adminUserId: string, brandId: string) {
  if (await roleIn(tx, brandId, adminUserId)) throw brandError(403, "own_brand");
}

async function lockForDecision(tx: Tx, brandId: string) {
  // Lock order: the account's users row, then the brand row (ADR 0013 style; an approval changes is_verified).
  const [account] = await tx.select().from(users).where(eq(users.id, brandId)).for("no key update");
  const [brand] = await tx.select().from(brands).where(eq(brands.id, brandId)).for("update");
  if (!account || !brand || account.deletedAt) throw brandError(404, "not_found");
  return { account, brand };
}

/** An admin approves a brand in review: verified, its corner opens, its team is told. Logged with the reason. */
export async function approveBrand(adminUserId: string, brandId: string, reason: string, now = new Date()) {
  return db.transaction(async (tx) => {
    await assertNoInterest(tx, adminUserId, brandId);
    const { account, brand } = await lockForDecision(tx, brandId);
    // A repeat answers the same, with the corner approval opened (createBrandCorner leaves an open one as it is).
    if (brand.verificationStatus === "verified") return { status: "verified" as const, replayed: true, cornerId: (await createBrandCorner(tx, brandId, now)).id };
    if (brand.verificationStatus !== "in_review") throw brandError(409, "not_in_review", { status: brand.verificationStatus });
    // The checklist could have changed since it was sent (a payout account removed): review what's there now.
    const checklist = await checklistFor(tx, brand);
    if (!checklist.complete) throw brandError(422, "checklist_incomplete", { checklist });
    await tx.update(brands).set({ verificationStatus: "verified", verificationNote: null, decidedAt: now, decidedByUserId: adminUserId }).where(eq(brands.id, brandId));
    await tx.update(users).set({ isVerified: true }).where(eq(users.id, brandId));
    const corner = await createBrandCorner(tx, brandId, now);
    await recordBrandEvent(tx, { brandId, kind: "approved", actorUserId: adminUserId, detail: { reason, cornerId: corner.id } });
    await recordAdminAction(tx, {
      adminUserId, action: "brand.approve", targetType: "brand", targetId: brandId, reason,
      before: { verificationStatus: brand.verificationStatus, isVerified: account.isVerified }, after: { verificationStatus: "verified", isVerified: true, cornerId: corner.id },
    });
    await tellTeam(tx, account, "approved", now);
    return { status: "verified" as const, replayed: false, cornerId: corner.id };
  });
}

/**
 * An admin sends a brand back with a note: one in review, or a verified one (which is unverified until approved
 * again; its corner and follows stay, ADR 0017 §7). Logged with the note as the reason.
 */
export async function requestBrandChanges(adminUserId: string, brandId: string, note: string, now = new Date()) {
  return db.transaction(async (tx) => {
    await assertNoInterest(tx, adminUserId, brandId);
    const { account, brand } = await lockForDecision(tx, brandId);
    if (brand.verificationStatus !== "in_review" && brand.verificationStatus !== "verified") throw brandError(409, "not_in_review", { status: brand.verificationStatus });
    await tx.update(brands).set({ verificationStatus: "changes_needed", verificationNote: note, decidedAt: now, decidedByUserId: adminUserId }).where(eq(brands.id, brandId));
    await tx.update(users).set({ isVerified: false }).where(eq(users.id, brandId));
    await recordBrandEvent(tx, { brandId, kind: "changes_requested", actorUserId: adminUserId, detail: { note } });
    await recordAdminAction(tx, {
      adminUserId, action: "brand.request_changes", targetType: "brand", targetId: brandId, reason: note,
      before: { verificationStatus: brand.verificationStatus, isVerified: account.isVerified }, after: { verificationStatus: "changes_needed", isVerified: false },
    });
    await tellTeam(tx, account, "changes_needed", now);
    return { status: "changes_needed" as const, note };
  });
}

/** Is this brand verified (approved and not sent back)? */
export async function isVerifiedBrand(conn: Conn, brandId: string): Promise<boolean> {
  const found = await liveBrand(conn, brandId);
  return !!found && found.brand.verificationStatus === "verified" && found.account.isVerified;
}

/** For the admin queue: brands waiting longest first. */
export const reviewQueueOrder = sql`${brands.submittedAt} asc nulls last`;
