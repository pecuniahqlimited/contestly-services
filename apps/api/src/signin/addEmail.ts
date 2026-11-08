/**
 * Adding an email to a signed-up account that has none verified (an Apple sign-in that hid it, say), by the
 * same 6-digit code as sign-in, with its limits. The code is bound to this account and to this purpose.
 * An email another account has is refused with email_in_use, which doesn't say whose; checked when the
 * code is asked for and again, under the row lock, when it's used. Changing a verified email isn't
 * possible yet (email_already_verified).
 */
import { and, eq, ne } from "drizzle-orm";
import { claimEmailInvites, db, users, type User } from "@contestly/db";
import { EMAIL_ALREADY_VERIFIED, EMAIL_IN_USE, type AddEmailResponse } from "@contestly/shared";
import type { Limits } from "../limits.js";
import { httpError } from "../httpError.js";
import { checkEmailCode, startEmailCode } from "./emailCode.js";

const PG_UNIQUE_VIOLATION = "23505";

function assertCanAdd(me: Pick<User, "email" | "emailVerifiedAt">) {
  if (me.email && me.emailVerifiedAt) throw httpError(409, EMAIL_ALREADY_VERIFIED);
}

async function assertFree(conn: Pick<typeof db, "select">, userId: string, email: string) {
  const [taken] = await conn.select({ id: users.id }).from(users).where(and(eq(users.email, email), ne(users.id, userId)));
  if (taken) throw httpError(409, EMAIL_IN_USE);
}

export async function startAddEmail(me: User, email: string, ip: string, limits: Limits) {
  assertCanAdd(me);
  await assertFree(db, me.id, email);
  return startEmailCode(me, email, ip, limits, "add_email");
}

export async function verifyAddEmail(me: User, email: string, code: string, ip: string, limits: Limits): Promise<AddEmailResponse> {
  assertCanAdd(me);
  await checkEmailCode(me, email, code, ip, limits, "add_email");
  try {
    return await db.transaction(async (tx) => {
      // FOR UPDATE: the email is a key column (the lock order, ADR 0013).
      const [fresh] = await tx.select().from(users).where(eq(users.id, me.id)).for("update");
      assertCanAdd(fresh);
      await assertFree(tx, me.id, email);
      const [u] = await tx.update(users).set({ email, emailVerifiedAt: new Date() }).where(eq(users.id, me.id)).returning();
      // Brand team invites sent to this address before it was theirs now wait for them (ADR 0017).
      await claimEmailInvites(tx, me.id, email);
      return { email: u.email!, emailVerifiedAt: u.emailVerifiedAt!.toISOString() };
    });
  } catch (e) {
    // Another account took it between the check and the write.
    if ((e as { code?: string }).code === PG_UNIQUE_VIOLATION) throw httpError(409, EMAIL_IN_USE);
    throw e;
  }
}
