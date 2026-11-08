/**
 * Deleting a brand (ADR 0017, the owner only): ADR 0010's soft delete of its account, refused for the same reasons
 * as a person's (cash in the wallet, a withdrawal not final, an open party it hosts, a payment issue), then the team
 * ends and open invites close. The corner is archived with its follows (archiveAccount).
 */
import { and, eq } from "drizzle-orm";
import { db } from "../client.js";
import { brandInvites, brandMembers, payoutAccounts, users, type User } from "../schema.js";
import { archiveAccount, deletionBlockers } from "../deletion.js";
import { assertBrandCan, brandError, recordBrandEvent } from "./team.js";

export async function deleteBrand(brandId: string, person: User, reason: string | null, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    await assertBrandCan(tx, brandId, person, "delete");
    // Lock order (ADR 0013): the brand's account row first; FOR UPDATE, the delete changes its handle (a key).
    const [account] = await tx.select().from(users).where(eq(users.id, brandId)).for("update");
    const blockers = (await deletionBlockers(tx, brandId)).filter((b) => b !== "owns_brand");
    if (blockers.length) throw brandError(409, blockers[0], { blockers });
    await archiveAccount(tx, account, reason, now);
    await tx.update(payoutAccounts).set({ removedAt: now }).where(and(eq(payoutAccounts.userId, brandId)));
    await tx.update(brandInvites).set({ status: "revoked", respondedAt: now }).where(and(eq(brandInvites.brandId, brandId), eq(brandInvites.status, "pending")));
    const team = await tx.delete(brandMembers).where(eq(brandMembers.brandId, brandId)).returning();
    await recordBrandEvent(tx, { brandId, kind: "deleted", actorUserId: person.id, detail: { reason, team: team.map((m) => ({ userId: m.userId, role: m.role })) } });
  });
}
