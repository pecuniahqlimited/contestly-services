import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, max, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { canWithdraw, db, follows, liveUser, parties, partyPlayers, users, ledger } from "@contestly/db";
import { addPhoneSchema, contactsMatchSchema, deleteAccountResponseSchema, deleteAccountSchema, deletionStatusSchema, guestNameSchema, upsertMeSchema } from "@contestly/shared";
import { requireSession, requireUser } from "../auth.js";
import { httpError } from "../httpError.js";
import { addPhone, matchContacts } from "../phone.js";
import { myParties } from "../myParties.js";
import { personColumns } from "../people.js";
import { publicUser } from "./users.js";
import { deleteAccount, deletionStatus } from "../accountDeletion.js";

/** People you've played with, at most this many. */
const PLAYED_WITH_LIMIT = 20;

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";

export async function meRoutes(app: FastifyInstance) {
  /** The session's own account. Guests get it too (isGuest), with an empty wallet: coins arrive at sign-up. */
  app.get("/me", async (req) => {
    const u = requireSession(req);
    return {
      ...publicUser(u), isGuest: u.isGuest, isAdmin: u.isAdmin, email: u.email, phoneAdded: !!u.phoneVerifiedAt,
      canWithdraw: canWithdraw(u), wallet: await ledger.balances(u.id),
    };
  });

  /**
   * Before deleting: what would stop it (cash, an unfinished party) and whether the re-verification is
   * fresh. Signing in again (email code, Google or Apple) to this account opens a 5-minute window.
   */
  app.get("/me/deletion", async (req) => deletionStatusSchema.parse(await deletionStatus(requireUser(req))));

  /**
   * Delete the account (ADR 0010): a soft delete, within the re-verification window. 403 reverify_required,
   * 409 cash_balance or active_party (with details.message). The session stops working (account_gone).
   */
  app.delete("/me", async (req) => {
    const me = requireUser(req);
    const { reason } = deleteAccountSchema.parse(req.body ?? {});
    return deleteAccountResponseSchema.parse(await deleteAccount(me, reason, req.log));
  });

  /** Name and face (and Me edits): display name, @handle, avatar, bio, interests. Signed-up accounts only. */
  app.post("/me", async (req) => {
    const me = requireUser(req);
    const body = upsertMeSchema.parse(req.body);
    try {
      const [u] = await db.update(users).set(body).where(eq(users.id, me.id)).returning();
      return { ...publicUser(u), wallet: await ledger.balances(u.id) };
    } catch (e) {
      if (isUniqueViolation(e)) throw httpError(409, "handle_taken");
      throw e;
    }
  });

  /** A guest's name for the free party they were invited to. */
  app.post("/me/guest", async (req) => {
    const me = requireSession(req);
    if (!me.isGuest) throw httpError(409, "not_a_guest");
    const { displayName } = guestNameSchema.parse(req.body);
    const [u] = await db.update(users).set({ displayName }).where(eq(users.id, me.id)).returning();
    return { ...publicUser(u), isGuest: true };
  });

  /** Add (or replace) the optional number, verified by SMS. One account per number. */
  app.post("/me/phone", async (req) => addPhone(requireUser(req), addPhoneSchema.parse(req.body).idToken));

  /** Which contacts are here: hashed numbers in, people who added a number out. Nothing sent is stored. */
  app.post("/me/contacts/match", async (req) => matchContacts(requireUser(req), contactsMatchSchema.parse(req.body).hashes));

  /** Parties I host, play or am invited to, grouped invited / live / upcoming / recent, each with its last chat line. */
  app.get("/me/parties", async (req) => myParties(requireUser(req)));

  /** People from finished parties I played, whom I don't follow yet: most parties together, then most recent. No ranking beyond that. */
  app.get("/me/played-with", async (req) => {
    const me = requireUser(req);
    const mine = alias(partyPlayers, "mine");
    const ended = sql<Date>`coalesce(${parties.endedAt}, ${parties.startsAt})`;
    const rows = await db.select({ ...personColumns, partiesTogether: count(), lastPlayedAt: max(ended) })
      .from(mine)
      .innerJoin(parties, and(eq(parties.id, mine.partyId), eq(parties.status, "finished")))
      .innerJoin(partyPlayers, and(eq(partyPlayers.partyId, mine.partyId), ne(partyPlayers.userId, me.id)))
      .innerJoin(users, eq(users.id, partyPlayers.userId))
      .where(and(eq(mine.userId, me.id), eq(users.isSystem, false), eq(users.isGuest, false), liveUser,
        sql`not exists (select 1 from ${follows} f where f.follower_id = ${me.id} and f.followee_id = ${users.id})`))
      .groupBy(users.id)
      .orderBy(desc(count()), desc(max(ended)))
      .limit(PLAYED_WITH_LIMIT);
    return rows.map((r) => ({ ...r, partiesTogether: Number(r.partiesTogether), lastPlayedAt: new Date(r.lastPlayedAt as unknown as string).toISOString() }));
  });
}
