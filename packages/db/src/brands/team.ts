/**
 * Brands and their teams (ADR 0017). A brand is an account (users.is_brand) plus its `brands` row; its team is
 * brand_members, exactly one owner. Every change is a brand_events row in the same transaction. What a role may do
 * is brandRoleCan() in shared; assertBrandCan() is the one check every brand action goes through.
 */
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  BRAND_MAX_TEAM, BRAND_ROLE_FORBIDDEN, NOT_A_MEMBER, OWNER_MUST_HAND_OVER, brandRoleCan, normaliseCac, partyHasPrize,
  type AssignableBrandRole, type BrandCapability, type BrandEventKind, type BrandRole, type CreateBrandInput, type InviteBrandMemberInput, type UpdateBrandInput,
} from "@contestly/shared";
import { db, type Tx } from "../client.js";
import { brandEvents, brandInvites, brandMembers, brands, users, type Brand, type Party, type User } from "../schema.js";
import { liveUser } from "../accounts.js";
import { cleanName, cleanOptionalName } from "../safety/names.js";
import { isBanned } from "../payable.js";

type Conn = Tx | typeof db;

export const brandError = (statusCode: number, code: string, details?: Record<string, unknown>) =>
  Object.assign(new Error(code), { statusCode, ...(details ? { details } : {}) });

const PG_UNIQUE_VIOLATION = "23505";

/** A live brand: its account (not deleted) and its row. */
export async function liveBrand(conn: Conn, brandId: string): Promise<{ account: User; brand: Brand } | null> {
  const [row] = await conn.select({ account: users, brand: brands }).from(brands).innerJoin(users, eq(users.id, brands.id))
    .where(and(eq(brands.id, brandId), liveUser));
  return row ?? null;
}

/** This person's role on the brand, or null. */
export async function roleIn(conn: Conn, brandId: string, userId: string): Promise<BrandRole | null> {
  const [m] = await conn.select({ role: brandMembers.role }).from(brandMembers).where(and(eq(brandMembers.brandId, brandId), eq(brandMembers.userId, userId)));
  return m?.role ?? null;
}

export interface Acting { account: User; brand: Brand; role: BrandRole }

/**
 * May this person do `capability` for the brand? The brand's account and row, and their role; else 404
 * not_a_member (a live brand they're not on, or none at all: never say which) or 403 brand_role_forbidden.
 * A banned brand is refused like a banned person.
 */
export async function assertBrandCan(conn: Conn, brandId: string, person: Pick<User, "id">, capability: BrandCapability): Promise<Acting> {
  const [found, role] = await Promise.all([liveBrand(conn, brandId), roleIn(conn, brandId, person.id)]);
  if (!found || !role) throw brandError(404, NOT_A_MEMBER);
  if (isBanned(found.account)) throw brandError(403, "account_banned", { category: found.account.banCategory ?? null, until: found.account.bannedUntil?.toISOString() ?? null });
  if (!brandRoleCan(role, capability)) throw brandError(403, BRAND_ROLE_FORBIDDEN, { capability, role });
  return { ...found, role };
}

export async function recordBrandEvent(tx: Tx, e: { brandId: string; kind: BrandEventKind; actorUserId: string | null; subjectUserId?: string | null; detail?: Record<string, unknown> }) {
  await tx.insert(brandEvents).values({ brandId: e.brandId, kind: e.kind, actorUserId: e.actorUserId, subjectUserId: e.subjectUserId ?? null, detail: e.detail ?? {} });
}

/** The person row of the brand's owner (always one for a live brand). */
export async function ownerOf(conn: Conn, brandId: string): Promise<User | null> {
  const [row] = await conn.select({ u: users }).from(brandMembers).innerJoin(users, eq(users.id, brandMembers.userId))
    .where(and(eq(brandMembers.brandId, brandId), eq(brandMembers.role, "owner")));
  return row?.u ?? null;
}

/**
 * Who on the brand's team can't hold a prize in this party (ADR 0017 §6): everyone on the team, any role, when the
 * party is the brand's and has a prize of any kind; nobody for a free one or someone else's party.
 */
export async function brandTeamBarredFrom(conn: Conn, p: Pick<Party, "brandId" | "entryKobo" | "funding" | "prizeKind" | "hostPoolKobo">): Promise<Set<string>> {
  if (!p.brandId || !partyHasPrize(p)) return new Set();
  const rows = await conn.select({ id: brandMembers.userId }).from(brandMembers).where(eq(brandMembers.brandId, p.brandId));
  return new Set(rows.map((r) => r.id));
}

/** Team members holding a capability (whom a brand-side nudge goes to). */
export async function teamWith(conn: Conn, brandId: string, capability: BrandCapability): Promise<string[]> {
  const rows = await conn.select({ id: brandMembers.userId, role: brandMembers.role }).from(brandMembers).innerJoin(users, eq(users.id, brandMembers.userId))
    .where(and(eq(brandMembers.brandId, brandId), liveUser));
  return rows.filter((r) => brandRoleCan(r.role, capability)).map((r) => r.id);
}

// ---- making and editing ----------------------------------------------------------------

/** Who can make a brand: a signed-up person (not a brand) with a verified email or phone. */
function assertCanCreate(person: User) {
  if (person.isGuest) throw brandError(403, "sign_up_required");
  if (person.isBrand || person.isSystem) throw brandError(403, "not_a_person");
  if (!person.emailVerifiedAt && !person.phoneVerifiedAt) throw brandError(403, "verify_email_or_phone");
}

/**
 * The person makes a brand and owns it: the brand's account (a users row nobody signs in as), its brands row,
 * the owner's membership and the created event, in one transaction. A taken handle is 409 handle_taken.
 */
export async function createBrand(person: User, input: CreateBrandInput): Promise<{ account: User; brand: Brand }> {
  assertCanCreate(person);
  const [name, handle, bio] = await Promise.all([cleanName("displayName", input.name), cleanName("handle", input.handle), cleanOptionalName("bio", input.bio ?? null)]);
  try {
    return await db.transaction(async (tx) => {
      const [account] = await tx.insert(users).values({
        handle, displayName: name, avatarEmoji: input.logoEmoji, bio, isBrand: true, who: "brand", interests: input.lane ? [input.lane] : [], isSim: person.isSim,
      }).returning();
      const [brand] = await tx.insert(brands).values({
        id: account.id, lane: input.lane ?? null, siteUrl: input.siteUrl ?? null, socials: input.socials ?? {},
        registrationNumber: input.registrationNumber ? normaliseCac(input.registrationNumber) : null, cashPrizes: input.cashPrizes, createdByUserId: person.id,
      }).returning();
      await tx.insert(brandMembers).values({ brandId: account.id, userId: person.id, role: "owner" });
      await recordBrandEvent(tx, { brandId: account.id, kind: "created", actorUserId: person.id, subjectUserId: person.id, detail: { handle } });
      return { account, brand };
    });
  } catch (e) {
    if ((e as { code?: string }).code === PG_UNIQUE_VIOLATION) throw brandError(409, "handle_taken");
    throw e;
  }
}

/**
 * Lock a brand for a change that must see its row as it is: the account's users row, then the brand row (the order
 * every brand write takes, ADR 0013 style, so settings and an admin's decision never deadlock).
 */
export async function lockBrandRows(tx: Tx, brandId: string): Promise<{ account: User | undefined; brand: Brand | undefined }> {
  const [account] = await tx.select().from(users).where(eq(users.id, brandId)).for("no key update");
  const [brand] = await tx.select().from(brands).where(eq(brands.id, brandId)).for("update");
  return { account, brand };
}

type LogoFields = Pick<Partial<typeof brands.$inferInsert>, "logoKey" | "pendingLogoKey" | "pendingLogoAt" | "pendingLogoByUserId" | "logoRejectedNote" | "logoRejectedAt">;

/**
 * A new logo (ADR 0017 §1). A verified brand's waits for an admin while the live one stays (replacing one already
 * waiting); anyone else's goes live. Null, or the live logo sent again, withdraws what's waiting (null also takes
 * the live one down). Returns the columns to set and the objects nothing points at any more.
 */
function logoChange(brand: Brand, person: User, key: string | null, now: Date): { set: LogoFields; removed: string[]; submitted: boolean } {
  const removed = (...keys: (string | null)[]) => keys.filter((k): k is string => !!k && k !== key);
  if (key && key === brand.pendingLogoKey) return { set: {}, removed: [], submitted: false };
  if (key && brand.verificationStatus === "verified" && key !== brand.logoKey) {
    return {
      set: { pendingLogoKey: key, pendingLogoAt: now, pendingLogoByUserId: person.id, logoRejectedNote: null, logoRejectedAt: null },
      removed: removed(brand.pendingLogoKey), submitted: true,
    };
  }
  return {
    set: { logoKey: key, pendingLogoKey: null, pendingLogoAt: null, pendingLogoByUserId: null, logoRejectedNote: null, logoRejectedAt: null },
    removed: removed(brand.logoKey, brand.pendingLogoKey), submitted: false,
  };
}

/** Fields a verified brand can't change without a new review. */
const LOCKED_WHEN_VERIFIED = ["registrationNumber"] as const;

/**
 * Settings (settings capability): profile fields on the account, the rest on the brand row. Logged as settings_changed
 * (and logo_submitted when a verified brand's new logo goes to review). Returns the logo objects to delete once this
 * has committed (a replaced or withdrawn logo).
 */
export async function updateBrand(brandId: string, person: User, input: UpdateBrandInput, now = new Date()): Promise<{ removed: string[] }> {
  const { brand } = await assertBrandCan(db, brandId, person, "settings");
  if (brand.verificationStatus === "verified" && LOCKED_WHEN_VERIFIED.some((k) => input[k] !== undefined && normaliseCac(input[k] ?? "") !== (brand[k] ?? ""))) {
    throw brandError(409, "brand_field_locked", { fields: [...LOCKED_WHEN_VERIFIED] });
  }
  const account: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) account.displayName = await cleanName("displayName", input.name);
  if (input.logoEmoji !== undefined) account.avatarEmoji = input.logoEmoji;
  if (input.bio !== undefined) account.bio = await cleanOptionalName("bio", input.bio);
  if (input.lane !== undefined) account.interests = input.lane ? [input.lane] : [];
  const row: Partial<typeof brands.$inferInsert> = {};
  if (input.lane !== undefined) row.lane = input.lane;
  if (input.siteUrl !== undefined) row.siteUrl = input.siteUrl;
  if (input.socials !== undefined) row.socials = input.socials;
  if (input.registrationNumber !== undefined) row.registrationNumber = input.registrationNumber ? normaliseCac(input.registrationNumber) : null;
  if (input.cashPrizes !== undefined) row.cashPrizes = input.cashPrizes;
  if (input.hostSpendLimitKobo !== undefined) row.hostSpendLimitKobo = input.hostSpendLimitKobo;
  return db.transaction(async (tx) => {
    const locked = (await lockBrandRows(tx, brandId)).brand!;
    const logo = input.logoKey !== undefined ? logoChange(locked, person, input.logoKey, now) : null;
    if (logo) Object.assign(row, logo.set);
    if (Object.keys(account).length) await tx.update(users).set(account).where(eq(users.id, brandId));
    if (Object.keys(row).length) await tx.update(brands).set(row).where(eq(brands.id, brandId));
    if (logo?.submitted) await recordBrandEvent(tx, { brandId, kind: "logo_submitted", actorUserId: person.id, detail: { key: input.logoKey, replaced: locked.pendingLogoKey } });
    // A change to the host spending limit is logged with what it was and what it became.
    const limit = input.hostSpendLimitKobo !== undefined && input.hostSpendLimitKobo !== locked.hostSpendLimitKobo
      ? { hostSpendLimitKobo: { from: locked.hostSpendLimitKobo, to: input.hostSpendLimitKobo } } : {};
    await recordBrandEvent(tx, { brandId, kind: "settings_changed", actorUserId: person.id, detail: { fields: Object.keys(input), ...limit } });
    return { removed: logo?.removed ?? [] };
  });
}

// ---- invites ---------------------------------------------------------------------------

/** Team size with open invites counted: an invite holds a place. */
async function placesTaken(tx: Tx, brandId: string) {
  const [[m], [i]] = await Promise.all([
    tx.select({ n: sql<number>`count(*)::int` }).from(brandMembers).where(eq(brandMembers.brandId, brandId)),
    tx.select({ n: sql<number>`count(*)::int` }).from(brandInvites).where(and(eq(brandInvites.brandId, brandId), eq(brandInvites.status, "pending"))),
  ]);
  return Number(m.n) + Number(i.n);
}

/** Lock the brand's row: team changes that must see one owner and one team size take it first. */
const lockBrand = (tx: Tx, brandId: string) => tx.select({ id: brands.id }).from(brands).where(eq(brands.id, brandId)).for("update");

export interface InviteResult { inviteId: string; to: { userId: string } | { email: string }; replayed: boolean; brandName: string; inviterName: string }

/**
 * Invite someone to the team (team.manage) by handle, or by email for someone who may not be on the app yet. An
 * email that a live, signed-up account already has goes straight to that account. One open invite per person
 * (or address) per brand: asking again answers with the open one. Refused: a brand, a guest, a banned or
 * deleted account, someone already on the team, a full team.
 */
export async function inviteMember(brandId: string, person: User, input: InviteBrandMemberInput): Promise<InviteResult> {
  return db.transaction(async (tx) => {
    const { account } = await assertBrandCan(tx, brandId, person, "team.manage");
    await lockBrand(tx, brandId);
    let invitee: User | null = null;
    let email: string | null = null;
    if ("handle" in input) {
      [invitee] = await tx.select().from(users).where(and(eq(users.handle, input.handle), liveUser));
      if (!invitee) throw brandError(404, "not_found");
    } else {
      email = input.email;
      [invitee] = await tx.select().from(users).where(and(eq(users.email, email), eq(users.isGuest, false), liveUser));
    }
    if (invitee) {
      if (invitee.isBrand || invitee.isSystem || invitee.isGuest) throw brandError(422, "cannot_invite");
      if (isBanned(invitee)) throw brandError(422, "cannot_invite");
      if (await roleIn(tx, brandId, invitee.id)) throw brandError(409, "already_member");
    }
    const open = await tx.select().from(brandInvites).where(and(eq(brandInvites.brandId, brandId), eq(brandInvites.status, "pending"),
      invitee ? eq(brandInvites.inviteeUserId, invitee.id) : and(isNull(brandInvites.inviteeUserId), eq(brandInvites.email, email!))));
    const base = { brandName: account.displayName, inviterName: person.displayName };
    if (open[0]) return { inviteId: open[0].id, to: invitee ? { userId: invitee.id } : { email: email! }, replayed: true, ...base };
    if ((await placesTaken(tx, brandId)) >= BRAND_MAX_TEAM) throw brandError(409, "team_full", { max: BRAND_MAX_TEAM });
    const [row] = await tx.insert(brandInvites).values({ brandId, inviteeUserId: invitee?.id ?? null, email, role: input.role, invitedByUserId: person.id }).returning();
    await recordBrandEvent(tx, { brandId, kind: "invited", actorUserId: person.id, subjectUserId: invitee?.id ?? null, detail: { inviteId: row.id, role: input.role, ...(invitee ? {} : { email }) } });
    return { inviteId: row.id, to: invitee ? { userId: invitee.id } : { email: email! }, replayed: false, ...base };
  });
}

/**
 * An account with this verified email takes over email invites sent to it before it existed (called at sign-up
 * and when an email is added). Each then waits for its accept or decline like any invite. One for a brand where
 * the account already has an open invite or a seat is revoked instead.
 */
export async function claimEmailInvites(tx: Tx, userId: string, email: string): Promise<number> {
  const waiting = await tx.select().from(brandInvites).where(and(eq(brandInvites.email, email.toLowerCase()), isNull(brandInvites.inviteeUserId), eq(brandInvites.status, "pending")));
  let claimed = 0;
  for (const inv of waiting) {
    const [dup] = await tx.select({ id: brandInvites.id }).from(brandInvites).where(and(eq(brandInvites.brandId, inv.brandId), eq(brandInvites.inviteeUserId, userId), eq(brandInvites.status, "pending")));
    if (dup || (await roleIn(tx, inv.brandId, userId))) {
      await tx.update(brandInvites).set({ status: "revoked", respondedAt: new Date() }).where(eq(brandInvites.id, inv.id));
      continue;
    }
    await tx.update(brandInvites).set({ inviteeUserId: userId }).where(eq(brandInvites.id, inv.id));
    claimed++;
  }
  return claimed;
}

/** Accept or decline an invite to me. Accepting makes me a member with its role (the team size was held by the invite). */
export async function answerInvite(inviteId: string, person: User, accept: boolean): Promise<{ brandId: string; status: "accepted" | "declined"; replayed: boolean }> {
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(brandInvites).where(and(eq(brandInvites.id, inviteId), eq(brandInvites.inviteeUserId, person.id))).for("update");
    if (!inv) throw brandError(404, "not_found");
    const want = accept ? "accepted" : "declined";
    if (inv.status === want) return { brandId: inv.brandId, status: want, replayed: true };
    if (inv.status !== "pending") throw brandError(409, "invite_closed", { status: inv.status });
    if (!(await liveBrand(tx, inv.brandId))) throw brandError(409, "invite_closed", { status: "brand_gone" });
    await lockBrand(tx, inv.brandId);
    if (accept) {
      if (person.isGuest) throw brandError(403, "sign_up_required");
      await tx.insert(brandMembers).values({ brandId: inv.brandId, userId: person.id, role: inv.role, invitedByUserId: inv.invitedByUserId }).onConflictDoNothing();
    }
    await tx.update(brandInvites).set({ status: want, respondedAt: new Date() }).where(eq(brandInvites.id, inv.id));
    await recordBrandEvent(tx, { brandId: inv.brandId, kind: accept ? "invite_accepted" : "invite_declined", actorUserId: person.id, subjectUserId: person.id, detail: { inviteId, role: inv.role } });
    return { brandId: inv.brandId, status: want, replayed: false };
  });
}

/** Take back an open invite (team.manage). */
export async function revokeInvite(brandId: string, person: User, inviteId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertBrandCan(tx, brandId, person, "team.manage");
    const [inv] = await tx.update(brandInvites).set({ status: "revoked", respondedAt: new Date() })
      .where(and(eq(brandInvites.id, inviteId), eq(brandInvites.brandId, brandId), eq(brandInvites.status, "pending"))).returning();
    if (!inv) throw brandError(404, "not_found");
    await recordBrandEvent(tx, { brandId, kind: "invite_revoked", actorUserId: person.id, subjectUserId: inv.inviteeUserId, detail: { inviteId } });
  });
}

// ---- roles, removing, leaving, hand-over -----------------------------------------------

async function memberRow(tx: Tx, brandId: string, userId: string) {
  const [m] = await tx.select().from(brandMembers).where(and(eq(brandMembers.brandId, brandId), eq(brandMembers.userId, userId))).for("update");
  if (!m) throw brandError(404, "not_found");
  return m;
}

/** Change a member's role (team.manage). The owner's role moves only by hand-over. */
export async function changeRole(brandId: string, person: User, userId: string, role: AssignableBrandRole): Promise<void> {
  await db.transaction(async (tx) => {
    await assertBrandCan(tx, brandId, person, "team.manage");
    await lockBrand(tx, brandId);
    const m = await memberRow(tx, brandId, userId);
    if (m.role === "owner") throw brandError(409, OWNER_MUST_HAND_OVER);
    if (m.role === role) return;
    await tx.update(brandMembers).set({ role }).where(and(eq(brandMembers.brandId, brandId), eq(brandMembers.userId, userId)));
    await recordBrandEvent(tx, { brandId, kind: "role_changed", actorUserId: person.id, subjectUserId: userId, detail: { from: m.role, to: role } });
  });
}

/** Remove someone from the team (team.manage). Not the owner; yourself is a leave. */
export async function removeMember(brandId: string, person: User, userId: string): Promise<void> {
  if (userId === person.id) return leaveBrand(brandId, person);
  await db.transaction(async (tx) => {
    await assertBrandCan(tx, brandId, person, "team.manage");
    await lockBrand(tx, brandId);
    const m = await memberRow(tx, brandId, userId);
    if (m.role === "owner") throw brandError(409, OWNER_MUST_HAND_OVER);
    await tx.delete(brandMembers).where(and(eq(brandMembers.brandId, brandId), eq(brandMembers.userId, userId)));
    await recordBrandEvent(tx, { brandId, kind: "removed", actorUserId: person.id, subjectUserId: userId, detail: { role: m.role } });
  });
}

/** Leave a team. The owner can't: they hand over or delete the brand. */
export async function leaveBrand(brandId: string, person: User): Promise<void> {
  await db.transaction(async (tx) => {
    await lockBrand(tx, brandId);
    const [m] = await tx.select().from(brandMembers).where(and(eq(brandMembers.brandId, brandId), eq(brandMembers.userId, person.id))).for("update");
    if (!m) throw brandError(404, NOT_A_MEMBER);
    if (m.role === "owner") throw brandError(409, OWNER_MUST_HAND_OVER);
    await tx.delete(brandMembers).where(and(eq(brandMembers.brandId, brandId), eq(brandMembers.userId, person.id)));
    await recordBrandEvent(tx, { brandId, kind: "left", actorUserId: person.id, subjectUserId: person.id, detail: { role: m.role } });
  });
}

/**
 * Hand ownership to another member (ownership capability): they become the owner, the old owner an admin, in one
 * transaction with the brand row locked, so a brand never has none or two (the old owner steps down first: the
 * one-owner index holds at every statement).
 */
export async function handOver(brandId: string, person: User, toUserId: string): Promise<void> {
  if (toUserId === person.id) throw brandError(409, "already_owner");
  await db.transaction(async (tx) => {
    await assertBrandCan(tx, brandId, person, "ownership");
    await lockBrand(tx, brandId);
    const target = await memberRow(tx, brandId, toUserId);
    const [u] = await tx.select().from(users).where(and(eq(users.id, toUserId), liveUser));
    if (!u || isBanned(u)) throw brandError(422, "cannot_hand_over");
    await tx.update(brandMembers).set({ role: "admin" }).where(and(eq(brandMembers.brandId, brandId), eq(brandMembers.userId, person.id)));
    await tx.update(brandMembers).set({ role: "owner" }).where(and(eq(brandMembers.brandId, brandId), eq(brandMembers.userId, toUserId)));
    await recordBrandEvent(tx, { brandId, kind: "handed_over", actorUserId: person.id, subjectUserId: toUserId, detail: { from: person.id, to: toUserId, theirRoleBefore: target.role } });
  });
}

/**
 * A person's account is deleted (ADR 0010): they leave every team they're on (not one they own: deletionBlockers
 * refuses an owner first) and their open invites close. Logged as a leave.
 */
export async function leaveBrandsOnDelete(tx: Tx, userId: string, now = new Date()): Promise<void> {
  const left = await tx.delete(brandMembers).where(and(eq(brandMembers.userId, userId), ne(brandMembers.role, "owner"))).returning();
  for (const m of left) await recordBrandEvent(tx, { brandId: m.brandId, kind: "left", actorUserId: userId, subjectUserId: userId, detail: { role: m.role, accountDeleted: true } });
  await tx.update(brandInvites).set({ status: "revoked", respondedAt: now }).where(and(eq(brandInvites.inviteeUserId, userId), eq(brandInvites.status, "pending")));
}

// ---- reading ---------------------------------------------------------------------------

/** The brands I'm on (with my role) and the invites waiting for me. */
export async function brandsOf(userId: string) {
  const [memberships, invites] = await Promise.all([
    db.select({ account: users, brand: brands, role: brandMembers.role }).from(brandMembers)
      .innerJoin(brands, eq(brands.id, brandMembers.brandId)).innerJoin(users, eq(users.id, brands.id))
      .where(and(eq(brandMembers.userId, userId), liveUser)).orderBy(asc(users.displayName)),
    db.select({ invite: brandInvites, account: users, brand: brands }).from(brandInvites)
      .innerJoin(brands, eq(brands.id, brandInvites.brandId)).innerJoin(users, eq(users.id, brands.id))
      .where(and(eq(brandInvites.inviteeUserId, userId), eq(brandInvites.status, "pending"), liveUser)).orderBy(asc(brandInvites.createdAt)),
  ]);
  const inviters = invites.length ? await db.select().from(users).where(inArray(users.id, invites.map((i) => i.invite.invitedByUserId))) : [];
  return { memberships, invites: invites.map((i) => ({ ...i, inviter: inviters.find((u) => u.id === i.invite.invitedByUserId)! })) };
}

/** The team (owner first, then by when they joined) and its open invites. */
export async function teamOf(brandId: string) {
  const ROLE_ORDER = sql`case ${brandMembers.role} when 'owner' then 0 when 'admin' then 1 when 'host' then 2 else 3 end`;
  const [members, invites] = await Promise.all([
    db.select({ u: users, role: brandMembers.role, joinedAt: brandMembers.joinedAt }).from(brandMembers).innerJoin(users, eq(users.id, brandMembers.userId))
      .where(eq(brandMembers.brandId, brandId)).orderBy(ROLE_ORDER, asc(brandMembers.joinedAt)),
    db.select().from(brandInvites).where(and(eq(brandInvites.brandId, brandId), eq(brandInvites.status, "pending"))).orderBy(asc(brandInvites.createdAt)),
  ]);
  const people = new Set(invites.flatMap((i) => [i.invitedByUserId, ...(i.inviteeUserId ? [i.inviteeUserId] : [])]));
  const rows = people.size ? await db.select().from(users).where(inArray(users.id, [...people])) : [];
  return { members, invites, people: new Map(rows.map((u) => [u.id, u])) };
}
