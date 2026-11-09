/**
 * Brands and teams (ADR 0017): acting as a brand (deny by default, membership, roles), each role's permissions,
 * invites by handle and by email (claimed at sign-up), hand-over and the always-an-owner rule, verification (the
 * checklist, the business email code, review, approval and its corner, changes needed and its nudge), unverified
 * brands hosting free parties only, the brand wallet (funding prizes, owner-only withdrawal), goods fulfilment and
 * its nudges, the brand messaging rule, and the team's lockout from the brand's curate parties.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InjectOptions } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  adminActions, adminAlerts, newMember, brandEvents, brandMembers, chatMessages, corners, db, getChatConfig, ledger, nudges, parties, partyPlayers, postMessage,
  prizeFulfilments, recordDeliveryNudges, sql, threadById, users, type User,
} from "@contestly/db";
import { kobo, type NudgeKind } from "@contestly/shared";
import { resetProviders } from "@contestly/payments";
import { valkey } from "../src/redis.js";
import { hmac } from "../src/signin/secrets.js";
import { as, asBrand, clientAddress, makeBrand, makeUser, tag, testApp } from "./harness.js";
import { settle } from "../../worker/src/partySettle.js";

type App = Awaited<ReturnType<typeof testApp>>["app"];
let app: App;
let admin: User;
let n = 0;
const name = (p: string) => `${p}${++n}`;
const phoned = (p: string) => makeUser(name(p), { phone: `+23481${randomUUID().replace(/\D/g, "").slice(0, 8)}`, phoneVerifiedAt: new Date() });

beforeAll(async () => {
  delete process.env.PAYSTACK_SECRET_KEY;
  delete process.env.PAYMENTS_PROVIDER;
  resetProviders();
  ({ app } = await testApp());
  admin = await makeUser("brandadmin", { isAdmin: true });
});
afterAll(async () => {
  await app.close();
  await sql.end();
});

const call = (opts: InjectOptions) => app.inject(opts);
const freeParty = (over: Record<string, unknown> = {}) => ({ title: "Brand quiz night", brief: "Afrobeats in the 2010s, the hits and the artists", funding: "pooled", entryKobo: 0, maxPlayers: 6, split: "winner", ...over });
const goodsParty = (over: Record<string, unknown> = {}) => freeParty({ funding: "host", prizeKind: "product", places: [{ text: "A branded hoodie" }], maxPlayers: 4, ...over });
const reload = async (u: { id: string }) => (await db.select().from(users).where(eq(users.id, u.id)))[0];
const nudgesOf = (userId: string, kind: NudgeKind) => db.select().from(nudges).where(and(eq(nudges.userId, userId), eq(nudges.kind, kind)));

/** A brand with one member per role: owner, admin, host, viewer (invited and accepted through the API). */
async function team(opts: { verified?: boolean } = {}) {
  const owner = await phoned("own");
  const brand = await makeBrand(owner, opts);
  const members = { admin: await makeUser(name("adm")), host: await makeUser(name("hst")), viewer: await makeUser(name("vwr")) };
  for (const [role, u] of Object.entries(members)) {
    const inv = await call({ method: "POST", url: `/brands/${brand.id}/invites`, headers: as(owner), payload: { handle: u.handle, role } });
    expect(inv.statusCode, inv.body).toBe(201);
    expect((await call({ method: "POST", url: `/brand-invites/${inv.json().inviteId}/accept`, headers: as(u) })).statusCode).toBe(200);
  }
  return { owner, brand, ...members };
}

/** TEST-ONLY: the code went out by mail; swap its HMAC for one of a code we know (as addEmail.test does). */
const CODE = "424242";
async function knowCode(email: string) {
  expect(await valkey().hexists(`auth:email:${email}`, "hmac")).toBe(1);
  await valkey().hset(`auth:email:${email}`, "hmac", hmac("EMAIL_CODE_SECRET", `${email}:${CODE}`));
}

describe("acting as a brand", () => {
  it("is refused without a place on the team, on routes that don't opt in, and with a malformed id", async () => {
    const { owner, brand } = await team();
    const stranger = await makeUser(name("str"));
    const asStranger = await call({ method: "GET", url: "/wallet", headers: asBrand(stranger, brand) });
    expect([asStranger.statusCode, asStranger.json().error]).toEqual([404, "not_a_member"]);
    expect((await call({ method: "POST", url: "/parties", headers: asBrand(stranger, brand), payload: freeParty() })).json().error).toBe("not_a_member");
    // A brand never joins, climbs or reads "me": the header is refused before the handler.
    const p = (await call({ method: "POST", url: "/parties", headers: as(owner), payload: freeParty() })).json();
    for (const [method, url] of [["POST", `/parties/${p.id}/join`], ["GET", "/me"], ["GET", "/climb"], ["POST", "/crews"]] as const) {
      const r = await call({ method, url, headers: asBrand(owner, brand), payload: method === "POST" ? {} : undefined });
      expect([r.statusCode, r.json().error], url).toEqual([400, "not_available_as_brand"]);
    }
    expect((await call({ method: "GET", url: "/wallet", headers: { ...as(owner), "x-act-as": "not-a-uuid" } })).statusCode).toBe(400);
    // Someone else's brand, as a member of another: still not a member.
    const other = await team();
    expect((await call({ method: "GET", url: "/wallet", headers: asBrand(other.owner, brand) })).json().error).toBe("not_a_member");
  });

  it("a banned brand can't be acted as", async () => {
    const { owner, brand } = await team();
    await db.update(users).set({ bannedAt: new Date() }).where(eq(users.id, brand.id));
    const r = await call({ method: "GET", url: "/wallet", headers: asBrand(owner, brand) });
    expect([r.statusCode, r.json().error]).toEqual([403, "account_banned"]);
  });
});

describe("each role's permissions", () => {
  it("owner, admin, host and viewer each get what the table says, and no more", async () => {
    const t = await team({ verified: true });
    const roles = { owner: t.owner, admin: t.admin, host: t.host, viewer: t.viewer };
    const ok = (s: number) => s < 300;
    const check = async (label: string, run: (u: User) => Promise<number>, allowed: (keyof typeof roles)[]) => {
      for (const [role, u] of Object.entries(roles) as [keyof typeof roles, User][]) {
        const status = await run(u);
        expect(ok(status), `${label} as ${role} (${status})`).toBe(allowed.includes(role));
        if (!ok(status)) expect(status, `${label} as ${role}`).toBe(403);
      }
    };
    await check("read settings", async (u) => (await call({ method: "GET", url: `/brands/${t.brand.id}/settings`, headers: as(u) })).statusCode, ["owner", "admin", "host", "viewer"]);
    await check("edit settings", async (u) => (await call({ method: "PATCH", url: `/brands/${t.brand.id}`, headers: as(u), payload: { bio: `Edited by ${u.handle}` } })).statusCode, ["owner", "admin"]);
    await check("invite", async (u) => (await call({ method: "POST", url: `/brands/${t.brand.id}/invites`, headers: as(u), payload: { email: `inv-${u.id}@example.com`, role: "viewer" } })).statusCode, ["owner", "admin"]);
    await check("see the wallet", async (u) => (await call({ method: "GET", url: "/wallet", headers: asBrand(u, t.brand) })).statusCode, ["owner", "admin"]);
    await check("top up", async (u) => (await call({ method: "POST", url: "/wallet/dev-topup", headers: asBrand(u, t.brand), payload: { nairaAmount: 10 } })).statusCode, ["owner", "admin"]);
    await check("list banks (payout accounts)", async (u) => (await call({ method: "GET", url: "/wallet/banks", headers: asBrand(u, t.brand) })).statusCode, ["owner"]);
    await check("host a party", async (u) => (await call({ method: "POST", url: "/parties", headers: asBrand(u, t.brand), payload: freeParty() })).statusCode, ["owner", "admin", "host"]);
    await check("read the inbox", async (u) => (await call({ method: "GET", url: "/chats", headers: asBrand(u, t.brand) })).statusCode, ["owner", "admin", "host", "viewer"]);
    await check("manage the corner", async (u) => (await call({ method: "PATCH", url: "/me/corner", headers: asBrand(u, t.brand), payload: { bio: "Our corner" } })).statusCode, ["owner", "admin"]);
    const denied = await call({ method: "POST", url: `/brands/${t.brand.id}/owner`, headers: as(t.admin), payload: { userId: t.host.id } });
    expect([denied.statusCode, denied.json().error, denied.json().details]).toEqual([403, "brand_role_forbidden", { capability: "ownership", role: "admin" }]);
    expect((await call({ method: "DELETE", url: `/brands/${t.brand.id}`, headers: as(t.admin) })).statusCode).toBe(403);
    // A role change, by an admin; never to owner.
    expect((await call({ method: "PATCH", url: `/brands/${t.brand.id}/members/${t.viewer.id}`, headers: as(t.admin), payload: { role: "host" } })).statusCode).toBe(204);
    expect((await call({ method: "PATCH", url: `/brands/${t.brand.id}/members/${t.viewer.id}`, headers: as(t.admin), payload: { role: "owner" } })).statusCode).toBe(400);
    expect((await call({ method: "POST", url: "/parties", headers: asBrand(t.viewer, t.brand), payload: freeParty() })).statusCode).toBe(201);
  });
});

describe("invites", () => {
  it("to an existing account: accept puts them on the team; asking again is the same invite; a decline and a revoke close it", async () => {
    const { owner, brand } = await team();
    const ade = await makeUser(name("ade"));
    const first = await call({ method: "POST", url: `/brands/${brand.id}/invites`, headers: as(owner), payload: { handle: ade.handle, role: "host" } });
    expect(first.json()).toMatchObject({ to: "account", replayed: false });
    const again = await call({ method: "POST", url: `/brands/${brand.id}/invites`, headers: as(owner), payload: { handle: ade.handle, role: "host" } });
    expect([again.statusCode, again.json().inviteId, again.json().replayed]).toEqual([200, first.json().inviteId, true]);
    const mine = (await call({ method: "GET", url: "/me/brands", headers: as(ade) })).json();
    expect(mine.invites).toMatchObject([{ id: first.json().inviteId, role: "host", brand: { id: brand.id }, invitedBy: { id: owner.id } }]);
    // A body that isn't JSON (the app's live run sent the invite id) is a 400 that changes nothing, not a 500.
    const garbled = await call({ method: "POST", url: `/brand-invites/${first.json().inviteId}/accept`, headers: { ...as(ade), "content-type": "application/json" }, payload: first.json().inviteId });
    expect([garbled.statusCode, garbled.json().error]).toEqual([400, "invalid_json"]);
    expect((await call({ method: "GET", url: "/me/brands", headers: as(ade) })).json().invites).toHaveLength(1);
    expect((await call({ method: "POST", url: `/brand-invites/${first.json().inviteId}/accept`, headers: { ...as(ade), "content-type": "application/json" }, payload: "{}" })).json()).toMatchObject({ status: "accepted", replayed: false });
    expect((await call({ method: "GET", url: "/me/brands", headers: as(ade) })).json().brands).toMatchObject([{ id: brand.id, role: "host" }]);
    expect((await call({ method: "POST", url: `/brands/${brand.id}/invites`, headers: as(owner), payload: { handle: ade.handle, role: "admin" } })).json().error).toBe("already_member");
    // Someone else declines; another invite is revoked before an answer.
    const bola = await makeUser(name("bola"));
    const toBola = (await call({ method: "POST", url: `/brands/${brand.id}/invites`, headers: as(owner), payload: { handle: bola.handle, role: "viewer" } })).json();
    expect((await call({ method: "POST", url: `/brand-invites/${toBola.inviteId}/decline`, headers: as(bola) })).json()).toMatchObject({ status: "declined" });
    expect((await call({ method: "POST", url: `/brand-invites/${toBola.inviteId}/accept`, headers: as(bola) })).json().error).toBe("invite_closed");
    const cole = await makeUser(name("cole"));
    const toCole = (await call({ method: "POST", url: `/brands/${brand.id}/invites`, headers: as(owner), payload: { handle: cole.handle, role: "viewer" } })).json();
    expect((await call({ method: "DELETE", url: `/brands/${brand.id}/invites/${toCole.inviteId}`, headers: as(owner) })).statusCode).toBe(204);
    expect((await call({ method: "POST", url: `/brand-invites/${toCole.inviteId}/accept`, headers: as(cole) })).json().error).toBe("invite_closed");
    // Nobody can answer someone else's invite; brands and guests can't be invited.
    expect((await call({ method: "POST", url: `/brand-invites/${first.json().inviteId}/accept`, headers: as(cole) })).statusCode).toBe(404);
    expect((await call({ method: "POST", url: `/brands/${brand.id}/invites`, headers: as(owner), payload: { handle: (await makeBrand(cole)).handle, role: "viewer" } })).json().error).toBe("cannot_invite");
    const kinds = (await db.select({ kind: brandEvents.kind }).from(brandEvents).where(eq(brandEvents.brandId, brand.id))).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["created", "invited", "invite_accepted", "invite_declined", "invite_revoked"]));
  });

  it("by email to someone not on the app: the invite waits on the account they sign up with, for their answer", async () => {
    const { owner, brand } = await team();
    const email = `newbie-${tag}-${++n}@example.com`;
    const sent = await call({ method: "POST", url: `/brands/${brand.id}/invites`, headers: as(owner), payload: { email, role: "viewer" } });
    expect(sent.json()).toMatchObject({ to: "email", replayed: false });
    const team1 = (await call({ method: "GET", url: `/brands/${brand.id}/team`, headers: as(owner) })).json();
    expect(team1.invites.find((i: { id: string }) => i.id === sent.json().inviteId)).toMatchObject({ to: { email } });
    // They sign up with that address (a guest becomes a member, as every sign-up does).
    const signedUp = await db.transaction(async (tx) => (await newMember(tx, email)).user);
    const mine = (await call({ method: "GET", url: "/me/brands", headers: as(signedUp) })).json();
    expect(mine.invites).toMatchObject([{ id: sent.json().inviteId, role: "viewer", brand: { id: brand.id } }]);
    expect(mine.brands).toEqual([]); // being emailed doesn't put you on a team
    expect((await call({ method: "POST", url: `/brand-invites/${sent.json().inviteId}/accept`, headers: as(signedUp) })).statusCode).toBe(200);
    expect((await call({ method: "GET", url: `/brands/${brand.id}/settings`, headers: as(signedUp) })).json().role).toBe("viewer");
    // An email someone already signs in with goes straight to their account.
    const known = await makeUser(name("known"));
    expect((await call({ method: "POST", url: `/brands/${brand.id}/invites`, headers: as(owner), payload: { email: known.email, role: "host" } })).json().to).toBe("account");
  });
});

describe("ownership", () => {
  it("hand-over makes a member the owner and the old owner an admin; a brand always has exactly one owner", async () => {
    const t = await team();
    const owners = async () => (await db.select().from(brandMembers).where(and(eq(brandMembers.brandId, t.brand.id), eq(brandMembers.role, "owner")))).map((m) => m.userId);
    expect(await owners()).toEqual([t.owner.id]);
    // The owner can't leave or be removed, or have their role changed; they hand over first.
    expect((await call({ method: "POST", url: `/brands/${t.brand.id}/leave`, headers: as(t.owner) })).json().error).toBe("owner_must_hand_over");
    expect((await call({ method: "DELETE", url: `/brands/${t.brand.id}/members/${t.owner.id}`, headers: as(t.admin) })).json().error).toBe("owner_must_hand_over");
    expect((await call({ method: "PATCH", url: `/brands/${t.brand.id}/members/${t.owner.id}`, headers: as(t.admin), payload: { role: "viewer" } })).json().error).toBe("owner_must_hand_over");
    // An owner can't delete their own account while they own it.
    expect((await call({ method: "GET", url: "/me/deletion", headers: as(t.owner) })).json().blockers.map((b: { code: string }) => b.code)).toContain("owns_brand");
    // Only to a member.
    expect((await call({ method: "POST", url: `/brands/${t.brand.id}/owner`, headers: as(t.owner), payload: { userId: (await makeUser(name("out"))).id } })).statusCode).toBe(404);
    expect((await call({ method: "POST", url: `/brands/${t.brand.id}/owner`, headers: as(t.owner), payload: { userId: t.host.id } })).statusCode).toBe(204);
    expect(await owners()).toEqual([t.host.id]);
    expect((await call({ method: "GET", url: `/brands/${t.brand.id}/settings`, headers: as(t.owner) })).json().role).toBe("admin");
    expect((await call({ method: "GET", url: "/me/deletion", headers: as(t.owner) })).json().blockers.map((b: { code: string }) => b.code)).not.toContain("owns_brand");
    // The old owner can now leave; the new one can't.
    expect((await call({ method: "POST", url: `/brands/${t.brand.id}/leave`, headers: as(t.owner) })).statusCode).toBe(204);
    expect((await call({ method: "POST", url: `/brands/${t.brand.id}/leave`, headers: as(t.host) })).json().error).toBe("owner_must_hand_over");
    // Two hand-overs at once can't leave two owners or none (the brand row is locked; one owner by the index).
    const t2 = await team();
    await Promise.allSettled([
      call({ method: "POST", url: `/brands/${t2.brand.id}/owner`, headers: as(t2.owner), payload: { userId: t2.admin.id } }),
      call({ method: "POST", url: `/brands/${t2.brand.id}/owner`, headers: as(t2.owner), payload: { userId: t2.host.id } }),
    ]);
    const after = await db.select().from(brandMembers).where(and(eq(brandMembers.brandId, t2.brand.id), eq(brandMembers.role, "owner")));
    expect(after).toHaveLength(1);
    const kinds = (await db.select({ kind: brandEvents.kind }).from(brandEvents).where(eq(brandEvents.brandId, t.brand.id))).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["handed_over", "left"]));
  });

  it("the owner deletes the brand only once it's empty: then its account is archived and the team ends", async () => {
    const t = await team();
    await call({ method: "POST", url: "/wallet/dev-topup", headers: asBrand(t.owner, t.brand), payload: { nairaAmount: 50 } });
    expect((await call({ method: "DELETE", url: `/brands/${t.brand.id}`, headers: as(t.owner) })).json().error).toBe("cash_balance");
    const t2 = await team();
    expect((await call({ method: "DELETE", url: `/brands/${t2.brand.id}`, headers: as(t2.owner) })).statusCode).toBe(204);
    expect((await reload(t2.brand)).deletedAt).not.toBeNull();
    expect(await db.select().from(brandMembers).where(eq(brandMembers.brandId, t2.brand.id))).toEqual([]);
    expect((await call({ method: "GET", url: `/brands/${t2.brand.id}`, headers: as(t2.owner) })).statusCode).toBe(404);
  });
});

describe("verification", () => {
  it("the checklist, the business email by code, review, changes needed (with its nudge), then approval and its corner", async () => {
    const t = await team();
    const id = t.brand.id;
    const submit = () => call({ method: "POST", url: `/brands/${id}/verification/submit`, headers: as(t.owner) });
    const incomplete = await submit();
    expect([incomplete.statusCode, incomplete.json().error]).toEqual([422, "checklist_incomplete"]);
    expect(incomplete.json().details.checklist).toMatchObject({ registrationNumber: false, logo: false, link: false, businessEmail: false, payoutAccount: "not_needed", complete: false });
    expect((await call({ method: "PATCH", url: `/brands/${id}`, headers: as(t.owner), payload: { registrationNumber: "rc 1234567" } })).json().registrationNumber).toBe("RC1234567");
    expect((await call({ method: "PATCH", url: `/brands/${id}`, headers: as(t.owner), payload: { registrationNumber: "12345" } })).statusCode).toBe(400);
    await call({ method: "PATCH", url: `/brands/${id}`, headers: as(t.owner), payload: { logoUrl: "https://brand.example/logo.png", socials: { instagram: "https://instagram.com/brand" }, cashPrizes: true } });
    // The business email: a code to it, bound to this person and brand.
    const email = `biz-${tag}-${++n}@brand.example`;
    expect((await call({ method: "POST", url: `/brands/${id}/business-email/start`, headers: as(t.owner), remoteAddress: clientAddress(), payload: { email } })).statusCode).toBe(200);
    await knowCode(email);
    expect((await call({ method: "POST", url: `/brands/${id}/business-email/verify`, headers: as(t.host), remoteAddress: clientAddress(), payload: { email, code: CODE } })).statusCode).toBe(403);
    const verified = await call({ method: "POST", url: `/brands/${id}/business-email/verify`, headers: as(t.owner), remoteAddress: clientAddress(), payload: { email, code: CODE } });
    expect(verified.json()).toMatchObject({ businessEmail: email, checklist: { businessEmail: true, payoutAccount: "missing", complete: false } });
    // It gives cash prizes, so a payout account (the owner's to add).
    const resolved = await call({ method: "POST", url: "/wallet/bank-accounts/resolve", headers: asBrand(t.owner, t.brand), payload: { bankCode: "001", accountNumber: `02${String(Date.now()).slice(-8)}` } });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((await call({ method: "POST", url: "/wallet/bank-accounts", headers: asBrand(t.owner, t.brand), payload: { resolveToken: resolved.json().resolveToken, accountName: resolved.json().accountName } })).statusCode).toBe(201);
    expect((await submit()).json()).toEqual({ status: "in_review", replayed: false });
    expect((await submit()).json()).toEqual({ status: "in_review", replayed: true });
    const queue = (await call({ method: "GET", url: "/admin/brands?status=in_review&limit=100", headers: as(admin) })).json().brands;
    expect(queue.some((b: { id: string }) => b.id === id)).toBe(true);
    // Not an admin: refused. An admin on the brand's own team: refused too (own_brand).
    expect((await call({ method: "POST", url: `/admin/brands/${id}/approve`, headers: as(t.owner), payload: { reason: "looks fine" } })).statusCode).toBe(403);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, t.viewer.id));
    const own = await call({ method: "POST", url: `/admin/brands/${id}/approve`, headers: as(await reload(t.viewer)), payload: { reason: "looks fine" } });
    expect([own.statusCode, own.json().error]).toEqual([403, "own_brand"]);
    await db.update(users).set({ isAdmin: false }).where(eq(users.id, t.viewer.id));
    // Changes needed, with a note the team sees and a nudge to the owner and admins (not hosts or viewers).
    expect((await call({ method: "POST", url: `/admin/brands/${id}/request-changes`, headers: as(admin), payload: { reason: "The logo is blurry" } })).json()).toEqual({ status: "changes_needed", note: "The logo is blurry" });
    expect((await call({ method: "GET", url: `/brands/${id}/settings`, headers: as(t.viewer) })).json().verification).toMatchObject({ status: "changes_needed", note: "The logo is blurry" });
    for (const u of [t.owner, t.admin]) expect((await nudgesOf(u.id, "verification_update")).map((x) => (x.data as { outcome: string }).outcome)).toEqual(["changes_needed"]);
    for (const u of [t.host, t.viewer]) expect(await nudgesOf(u.id, "verification_update")).toEqual([]);
    // Fixed and sent again: approved. Verified, the corner opens, the team hears.
    await call({ method: "PATCH", url: `/brands/${id}`, headers: as(t.owner), payload: { logoUrl: "https://brand.example/logo-sharp.png" } });
    expect((await submit()).statusCode).toBe(200);
    const approved = await call({ method: "POST", url: `/admin/brands/${id}/approve`, headers: as(admin), payload: { reason: "CAC checks out" } });
    expect(approved.json()).toMatchObject({ status: "verified", replayed: false });
    expect((await reload(t.brand)).isVerified).toBe(true);
    const [corner] = await db.select().from(corners).where(eq(corners.ownerUserId, id));
    expect(corner).toMatchObject({ status: "unlocked", level: 1, id: approved.json().cornerId });
    // Approving again answers the same, with the same corner.
    expect((await call({ method: "POST", url: `/admin/brands/${id}/approve`, headers: as(admin), payload: { reason: "CAC checks out" } })).json())
      .toEqual({ status: "verified", replayed: true, cornerId: approved.json().cornerId });
    expect((await call({ method: "GET", url: `/brands/${id}`, headers: as(t.viewer) })).json()).toMatchObject({ isVerified: true, cornerId: corner.id });
    expect((await call({ method: "GET", url: `/corners/${corner.id}`, headers: as(t.viewer) })).statusCode).toBe(200);
    for (const u of [t.owner, t.admin]) expect((await nudgesOf(u.id, "verification_update")).map((x) => (x.data as { outcome: string }).outcome).sort()).toEqual(["approved", "changes_needed"]);
    const logged = await db.select().from(adminActions).where(and(eq(adminActions.targetType, "brand"), eq(adminActions.targetId, id)));
    expect(logged.map((a) => [a.action, a.reason])).toEqual(expect.arrayContaining([["brand.request_changes", "The logo is blurry"], ["brand.approve", "CAC checks out"]]));
    // Verified: the CAC number is locked; goods are allowed now.
    expect((await call({ method: "PATCH", url: `/brands/${id}`, headers: as(t.owner), payload: { registrationNumber: "RC7654321" } })).json().error).toBe("brand_field_locked");
    expect((await call({ method: "POST", url: "/parties", headers: asBrand(t.host, t.brand), payload: goodsParty() })).statusCode).toBe(201);
    // The admin view: team, history, wallet.
    const detail = (await call({ method: "GET", url: `/admin/brands/${id}`, headers: as(admin) })).json();
    expect(detail).toMatchObject({ teamSize: 4, owner: { id: t.owner.id }, wallet: { payoutAccounts: 1 }, verification: { status: "verified" } });
    expect(detail.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["submitted", "changes_requested", "approved", "business_email_verified"]));
  });

  it("people search marks brands; a brand's corner never opens by the unlock thresholds", async () => {
    const t = await team({ verified: true });
    const seeker = await makeUser(name("seek"));
    const found = (await call({ method: "GET", url: `/users/search?q=${t.brand.handle}`, headers: as(seeker) })).json().people;
    expect(found.find((p: { id: string }) => p.id === t.brand.id)).toMatchObject({ isBrand: true, isVerified: true });
    expect(found.find((p: { id: string }) => p.id === t.owner.id)).toBeUndefined();
    const unverified = await team();
    const { checkUnlock } = await import("@contestly/db");
    expect(await db.transaction((tx) => checkUnlock(tx, unverified.brand.id))).toBe(false);
  });
});

describe("unverified brands", () => {
  it("host free parties only; the party is the brand's, and nobody is seated for hosting it", async () => {
    const t = await team();
    expect((await call({ method: "GET", url: "/parties/limits", headers: asBrand(t.host, t.brand) })).json()).toMatchObject({ freeOnly: true, canOfferGoods: false });
    await call({ method: "POST", url: "/wallet/dev-topup", headers: asBrand(t.owner, t.brand), payload: { nairaAmount: 10_000 } });
    for (const body of [freeParty({ entryKobo: kobo(200) }), freeParty({ funding: "host", hostPoolKobo: kobo(1000), maxPlayers: 4 })]) {
      expect((await call({ method: "POST", url: "/parties", headers: asBrand(t.host, t.brand), payload: body })).json().error).toBe("brand_not_verified");
    }
    expect((await call({ method: "POST", url: "/parties", headers: asBrand(t.host, t.brand), payload: goodsParty() })).json().error).toBe("prize_needs_verified_brand");
    const made = await call({ method: "POST", url: "/parties", headers: asBrand(t.host, t.brand), payload: freeParty() });
    expect(made.statusCode).toBe(201);
    expect(made.json().host).toMatchObject({ id: t.brand.id, kind: "brand", isBrand: true });
    const [row] = await db.select().from(parties).where(eq(parties.id, made.json().id));
    expect(row).toMatchObject({ brandId: t.brand.id, createdByUserId: t.host.id });
    expect(await db.select().from(partyPlayers).where(eq(partyPlayers.partyId, row.id))).toEqual([]);
    // Every host on the team can cancel it; a viewer can't.
    expect((await call({ method: "POST", url: `/parties/${row.id}/cancel`, headers: as(t.viewer), payload: {} })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: `/parties/${row.id}/cancel`, headers: as(t.admin), payload: {} })).statusCode).toBe(200);
  });
});

describe("the brand wallet", () => {
  it("funds the brand's cash prizes, separate from team members' own wallets; only the owner withdraws", async () => {
    const t = await team({ verified: true });
    await call({ method: "POST", url: "/wallet/dev-topup", headers: asBrand(t.admin, t.brand), payload: { nairaAmount: 20_000 } });
    const hostOwn = (await ledger.balances(t.host.id)).cashKobo;
    const prize = kobo(5_000);
    const cashParty = (hostPoolKobo: number) => freeParty({ funding: "host", hostPoolKobo, maxPlayers: 4 });
    // A Host spends from the brand's wallet only up to its host spending limit: ₦0 until an admin or the owner sets one.
    const refused = await call({ method: "POST", url: "/parties", headers: asBrand(t.host, t.brand), payload: cashParty(prize) });
    expect([refused.statusCode, refused.json().error, refused.json().details]).toEqual([403, "brand_role_forbidden", { capability: "parties.fund", role: "host", limitKobo: 0 }]);
    expect((await call({ method: "PATCH", url: `/brands/${t.brand.id}`, headers: as(t.host), payload: { hostSpendLimitKobo: prize } })).statusCode).toBe(403);
    const set = await call({ method: "PATCH", url: `/brands/${t.brand.id}`, headers: as(t.admin), payload: { hostSpendLimitKobo: prize } });
    expect(set.json().hostSpendLimitKobo).toBe(prize);
    const [logged] = await db.select().from(brandEvents).where(and(eq(brandEvents.brandId, t.brand.id), eq(brandEvents.kind, "settings_changed"), eq(brandEvents.actorUserId, t.admin.id)));
    expect(logged.detail).toMatchObject({ hostSpendLimitKobo: { from: 0, to: prize } });
    const over = await call({ method: "POST", url: "/parties", headers: asBrand(t.host, t.brand), payload: cashParty(prize + kobo(500)) });
    expect([over.json().error, over.json().details?.limitKobo]).toEqual(["brand_role_forbidden", prize]);
    // Admins and the owner fund up to the caps, whatever the hosts' limit; goods and entry parties aren't spending.
    const byAdmin = await call({ method: "POST", url: "/parties", headers: asBrand(t.admin, t.brand), payload: cashParty(prize * 2) });
    expect(byAdmin.statusCode, byAdmin.body).toBe(201);
    await call({ method: "POST", url: `/parties/${byAdmin.json().id}/cancel`, headers: as(t.admin), payload: {} });
    const made = await call({ method: "POST", url: "/parties", headers: asBrand(t.host, t.brand), payload: cashParty(prize) });
    expect(made.statusCode, made.body).toBe(201);
    expect((await ledger.balances(t.brand.id)).cashKobo).toBe(kobo(20_000) - prize);
    expect((await ledger.balances(t.host.id)).cashKobo).toBe(hostOwn);
    // Cancelling releases it back to the brand.
    await call({ method: "POST", url: `/parties/${made.json().id}/cancel`, headers: as(t.host), payload: {} });
    expect((await ledger.balances(t.brand.id)).cashKobo).toBe(kobo(20_000));
    expect((await call({ method: "GET", url: "/wallet", headers: asBrand(t.admin, t.brand) })).json().cashKobo).toBe(kobo(20_000));
    // A payout account, the owner's to add; then only the owner withdraws.
    const resolved = (await call({ method: "POST", url: "/wallet/bank-accounts/resolve", headers: asBrand(t.owner, t.brand), payload: { bankCode: "001", accountNumber: `03${String(Date.now()).slice(-8)}` } })).json();
    const account = (await call({ method: "POST", url: "/wallet/bank-accounts", headers: asBrand(t.owner, t.brand), payload: { resolveToken: resolved.resolveToken, accountName: resolved.accountName } })).json().accounts[0];
    const withdraw = (u: User) => call({ method: "POST", url: "/wallet/withdrawals", headers: asBrand(u, t.brand), payload: { amountKobo: kobo(1_500), bankAccountId: account.id, clientRequestId: randomUUID() } });
    expect((await withdraw(t.admin)).json()).toMatchObject({ error: "brand_role_forbidden", details: { capability: "wallet.withdraw" } });
    // The owner must pass a person's checks too: no verified phone, no withdrawal.
    await db.update(users).set({ phoneVerifiedAt: null }).where(eq(users.id, t.owner.id));
    expect((await withdraw(t.owner)).json()).toMatchObject({ error: "withdraw_not_allowed", details: { reason: "owner_cannot_withdraw" } });
    await db.update(users).set({ phoneVerifiedAt: new Date() }).where(eq(users.id, t.owner.id));
    const out = await withdraw(t.owner);
    expect(out.statusCode, out.body).toBe(201);
    expect(out.json().payout).toMatchObject({ amountKobo: kobo(1_500) });
    expect((await ledger.balances(t.brand.id)).cashKobo).toBe(kobo(20_000) - kobo(1_500));
    // An unverified brand can't withdraw at all.
    const u2 = await team();
    await call({ method: "POST", url: "/wallet/dev-topup", headers: asBrand(u2.owner, u2.brand), payload: { nairaAmount: 5_000 } });
    const r2 = (await call({ method: "POST", url: "/wallet/bank-accounts/resolve", headers: asBrand(u2.owner, u2.brand), payload: { bankCode: "001", accountNumber: `04${String(Date.now()).slice(-8)}` } })).json();
    const a2 = (await call({ method: "POST", url: "/wallet/bank-accounts", headers: asBrand(u2.owner, u2.brand), payload: { resolveToken: r2.resolveToken, accountName: r2.accountName } })).json().accounts[0];
    const unverified = await call({ method: "POST", url: "/wallet/withdrawals", headers: asBrand(u2.owner, u2.brand), payload: { amountKobo: kobo(1_500), bankAccountId: a2.id, clientRequestId: randomUUID() } });
    expect(unverified.json()).toMatchObject({ error: "withdraw_not_allowed", details: { reason: "brand_unverified" } });
  });
});

describe("goods prize fulfilment", () => {
  async function awarded(t: Awaited<ReturnType<typeof team>>, awardedAt = new Date()) {
    const winner = await makeUser(name("win"));
    const p = (await call({ method: "POST", url: "/parties", headers: asBrand(t.host, t.brand), payload: goodsParty() })).json();
    const [f] = await db.insert(prizeFulfilments).values({ partyId: p.id, place: 1, winnerUserId: winner.id, hostUserId: t.brand.id, prizeText: "A branded hoodie", awardedAt }).returning();
    return { winner, f, partyId: p.id };
  }
  const step = (u: User, t: { brand: User }, fid: string, status: "arranged" | "delivered", note?: string) =>
    call({ method: "POST", url: `/brands/${t.brand.id}/prizes/${fid}`, headers: as(u), payload: { status, ...(note ? { note } : {}) } });

  it("the brand arranges then delivers; the winner can dispute; prize_ready reaches the winner and the brand's hosts", async () => {
    const t = await team({ verified: true });
    const { winner, f, partyId } = await awarded(t);
    expect((await call({ method: "POST", url: `/me/prizes/${f.id}/dispute`, headers: as(winner), payload: { note: "Nothing yet" } })).json().error).toBe("fulfilment_step_not_allowed");
    expect((await step(t.viewer, t, f.id, "arranged")).json().error).toBe("brand_role_forbidden");
    expect((await step(t.host, t, f.id, "delivered")).json().error).toBe("fulfilment_step_not_allowed");
    expect((await step(t.host, t, f.id, "arranged", "Courier on Friday")).json()).toEqual({ status: "arranged", replayed: false });
    expect((await step(t.host, t, f.id, "arranged")).json()).toEqual({ status: "arranged", replayed: true });
    expect((await nudgesOf(winner.id, "prize_ready"))[0]?.data).toMatchObject({ fulfilmentId: f.id, partyId, for: "winner" });
    for (const u of [t.owner, t.admin, t.host]) expect((await nudgesOf(u.id, "prize_ready")).map((x) => (x.data as { for: string }).for)).toEqual(["brand"]);
    expect(await nudgesOf(t.viewer.id, "prize_ready")).toEqual([]);
    const mine = (await call({ method: "GET", url: "/me/prizes", headers: as(winner) })).json().prizes;
    expect(mine).toMatchObject([{ id: f.id, status: "arranged", note: "Courier on Friday", host: { id: t.brand.id } }]);
    expect((await call({ method: "POST", url: `/me/prizes/${f.id}/dispute`, headers: as(t.host), payload: { note: "Not mine" } })).statusCode).toBe(404);
    expect((await call({ method: "POST", url: `/me/prizes/${f.id}/dispute`, headers: as(winner), payload: { note: "Wrong size" } })).json()).toEqual({ status: "disputed", replayed: false });
    expect((await db.select().from(adminAlerts).where(eq(adminAlerts.dedupeKey, `prize_disputed:${f.id}`)))).toHaveLength(1);
    expect((await step(t.admin, t, f.id, "delivered", "Swapped for a large")).json()).toEqual({ status: "delivered", replayed: false });
    const owed = (await call({ method: "GET", url: `/brands/${t.brand.id}/prizes`, headers: as(t.viewer) })).json().prizes;
    expect(owed.find((x: { id: string }) => x.id === f.id)).toMatchObject({ status: "delivered", disputeNote: "Wrong size" });
    expect((await db.select().from(prizeFulfilments).where(eq(prizeFulfilments.id, f.id)))[0]).toMatchObject({ arrangedAt: expect.any(Date), deliveredAt: expect.any(Date), disputedAt: expect.any(Date) });
  });

  it("day 3 and day 7 after the award, while it isn't delivered, both sides hear once each", async () => {
    const t = await team({ verified: true });
    const day = 86_400_000;
    const { winner, f } = await awarded(t, new Date(Date.now() - 4 * day));
    const { f: delivered } = await awarded(t, new Date(Date.now() - 4 * day));
    await step(t.host, t, delivered.id, "arranged");
    await step(t.host, t, delivered.id, "delivered");
    await recordDeliveryNudges();
    await recordDeliveryNudges();
    const due = async (u: User) => (await nudgesOf(u.id, "prize_delivery_due")).filter((x) => (x.data as { fulfilmentId: string }).fulfilmentId === f.id).map((x) => (x.data as { day: number }).day);
    expect(await due(winner)).toEqual([3]);
    expect(await due(t.host)).toEqual([3]);
    expect(await due(t.viewer)).toEqual([]);
    expect((await nudgesOf(t.host.id, "prize_delivery_due")).some((x) => (x.data as { fulfilmentId: string }).fulfilmentId === delivered.id)).toBe(false);
    await db.update(prizeFulfilments).set({ awardedAt: new Date(Date.now() - 8 * day) }).where(eq(prizeFulfilments.id, f.id));
    await recordDeliveryNudges();
    await recordDeliveryNudges();
    expect((await due(winner)).sort()).toEqual([3, 7]);
    expect((await due(t.owner)).sort()).toEqual([3, 7]);
  });
});

describe("messages from a brand", () => {
  it("only to people who joined its parties, never cold; from the brand, with the team member kept; viewers read, hosts write", async () => {
    const t = await team({ verified: true });
    const player = await makeUser(name("ply"));
    const stranger = await makeUser(name("cold"));
    const p = (await call({ method: "POST", url: "/parties", headers: asBrand(t.host, t.brand), payload: freeParty() })).json();
    expect((await call({ method: "POST", url: `/parties/${p.id}/join`, headers: as(player) })).statusCode).toBeLessThan(300);
    const cold = await call({ method: "POST", url: `/dm/${stranger.id}`, headers: asBrand(t.host, t.brand) });
    expect([cold.statusCode, cold.json().error]).toEqual([403, "cannot_message"]);
    expect((await call({ method: "POST", url: `/dm/${player.id}`, headers: asBrand(t.viewer, t.brand) })).json().error).toBe("brand_role_forbidden");
    const opened = await call({ method: "POST", url: `/dm/${player.id}`, headers: asBrand(t.host, t.brand) });
    expect(opened.statusCode, opened.body).toBe(200);
    const threadId: string = opened.json().threadId;
    const thread = (await threadById(threadId))!;
    const brandRow = await reload(t.brand);
    const posted = await postMessage({ thread, sender: { ...brandRow, sentBy: t.host.id }, text: "Thanks for playing!", clientMsgId: randomUUID() }, { cfg: await getChatConfig(), voiceUploaded: async () => false });
    expect(posted.message.author).toMatchObject({ id: t.brand.id });
    const [line] = await db.select().from(chatMessages).where(eq(chatMessages.id, posted.message.id));
    expect(line).toMatchObject({ userId: t.brand.id, sentByUserId: t.host.id });
    // The whole team reads the brand's inbox; the player sees the brand, not the person.
    const inbox = (await call({ method: "GET", url: "/chats", headers: asBrand(t.viewer, t.brand) })).json();
    expect(JSON.stringify(inbox)).toContain(threadId);
    const page = (await call({ method: "GET", url: `/chats/${threadId}/messages`, headers: as(player) })).json();
    expect(JSON.stringify(page)).not.toContain(t.host.id);
    // A person writing to a brand that never hosted them is a request, not a refusal.
    expect((await call({ method: "POST", url: `/dm/${t.brand.id}`, headers: as(stranger) })).statusCode).toBe(200);
  });
});

describe("the team and the brand's parties", () => {
  it("its hosts can't play its curate parties; a viewer, not on the host team, can; a seated team member in its sealed party is a player", async () => {
    const t = await team({ verified: true });
    const curate = (await call({ method: "POST", url: "/parties", headers: asBrand(t.owner, t.brand), payload: freeParty({ mode: "curate", questionCount: 4 }) })).json();
    for (const u of [t.owner, t.admin, t.host]) {
      const r = await call({ method: "POST", url: `/parties/${curate.id}/join`, headers: as(u) });
      expect([r.statusCode, r.json().error], u.handle).toEqual([403, "seen_the_questions_cannot_play"]);
    }
    expect((await call({ method: "GET", url: `/parties/${curate.id}/drafts`, headers: as(t.viewer) })).statusCode).toBe(403);
    expect((await call({ method: "GET", url: `/parties/${curate.id}/drafts`, headers: as(t.admin) })).statusCode).toBe(200);
    expect((await call({ method: "POST", url: `/parties/${curate.id}/join`, headers: as(t.viewer) })).statusCode).toBeLessThan(300);
    // A viewer who opened the drafts some other way would be barred too (the existing lockout); the admin who did is.
    const sealed = (await call({ method: "POST", url: "/parties", headers: asBrand(t.owner, t.brand), payload: freeParty({ startsAt: new Date(Date.now() + 60 * 60_000).toISOString() }) })).json();
    expect((await call({ method: "POST", url: `/parties/${sealed.id}/join`, headers: as(t.host) })).statusCode).toBeLessThan(300);
    expect((await call({ method: "POST", url: `/parties/${sealed.id}/leave`, headers: as(t.host) })).statusCode).toBe(200);
    const mine = (await call({ method: "GET", url: "/me/parties", headers: as(t.admin) })).json();
    expect(JSON.stringify(mine)).toContain(curate.id);
  });
});

describe("the brand's team and its prizes", () => {
  const settleDeps = { emit: async () => undefined, publishLine: async () => undefined, queueRecordPlay: async () => undefined, queueRecordProgress: async () => undefined };
  const join = (u: User, partyId: string) => call({ method: "POST", url: `/parties/${partyId}/join`, headers: as(u) });
  /** Ranks written straight to the seats (best first), live, then the worker's own settle. */
  async function settleWith(partyId: string, order: User[]) {
    await db.update(parties).set({ status: "live", liveAt: new Date() }).where(eq(parties.id, partyId));
    for (const [i, u] of order.entries()) await db.update(partyPlayers).set({ rank: i + 1, score: 100 * (order.length - i) }).where(and(eq(partyPlayers.partyId, partyId), eq(partyPlayers.userId, u.id)));
    await settle(settleDeps, partyId);
  }

  it("no one on the team, any role, takes a seat in the brand's parties with a prize; its free parties are fine", async () => {
    const t = await team({ verified: true });
    await call({ method: "POST", url: "/wallet/dev-topup", headers: asBrand(t.owner, t.brand), payload: { nairaAmount: 5_000 } });
    const make = async (body: Record<string, unknown>) => (await call({ method: "POST", url: "/parties", headers: asBrand(t.admin, t.brand), payload: body })).json().id as string;
    const prized = [await make(freeParty({ entryKobo: kobo(200) })), await make(freeParty({ funding: "host", hostPoolKobo: kobo(1_000), maxPlayers: 4 })), await make(goodsParty())];
    for (const u of [t.owner, t.admin, t.host, t.viewer]) {
      await call({ method: "POST", url: "/wallet/dev-topup", headers: as(u), payload: { nairaAmount: 1_000 } });
      for (const id of prized) {
        const r = await join(u, id);
        expect([r.statusCode, r.json().error], `${u.handle} ${id}`).toEqual([403, "brand_team_member"]);
      }
      expect(await db.select().from(partyPlayers).where(eq(partyPlayers.userId, u.id))).toEqual([]);
    }
    expect((await join(t.viewer, await make(freeParty()))).statusCode).toBe(201);
    // Another brand's prize party is no business of this team's.
    const other = await team({ verified: true });
    const theirs = (await call({ method: "POST", url: "/parties", headers: asBrand(other.admin, other.brand), payload: freeParty({ entryKobo: kobo(200) }) })).json().id;
    expect((await join(t.viewer, theirs)).statusCode).toBe(201);
  });

  it("settlement checks it again: someone who joined the team after taking a seat wins nothing; the next player does", async () => {
    const t = await team({ verified: true });
    await call({ method: "POST", url: "/wallet/dev-topup", headers: asBrand(t.owner, t.brand), payload: { nairaAmount: 5_000 } });
    const prize = kobo(1_000);
    const cashId = (await call({ method: "POST", url: "/parties", headers: asBrand(t.admin, t.brand), payload: freeParty({ funding: "host", hostPoolKobo: prize, maxPlayers: 4 }) })).json().id;
    const goodsId = (await call({ method: "POST", url: "/parties", headers: asBrand(t.admin, t.brand), payload: goodsParty() })).json().id;
    const insider = await makeUser(name("ins"));
    const runnerUp = await makeUser(name("run"));
    for (const id of [cashId, goodsId]) for (const u of [insider, runnerUp]) expect((await join(u, id)).statusCode).toBe(201);
    // Seated, then on the team.
    const inv = (await call({ method: "POST", url: `/brands/${t.brand.id}/invites`, headers: as(t.owner), payload: { handle: insider.handle, role: "viewer" } })).json();
    await call({ method: "POST", url: `/brand-invites/${inv.inviteId}/accept`, headers: as(insider) });
    const insiderBefore = (await ledger.balances(insider.id)).cashKobo;
    await settleWith(cashId, [insider, runnerUp]);
    expect((await ledger.balances(insider.id)).cashKobo).toBe(insiderBefore);
    const seats = await db.select().from(partyPlayers).where(eq(partyPlayers.partyId, cashId));
    expect(seats.find((x) => x.userId === runnerUp.id)?.prizeKobo).toBe(prize);
    expect(seats.find((x) => x.userId === insider.id)?.prizeKobo ?? 0).toBe(0);
    await settleWith(goodsId, [insider, runnerUp]);
    expect((await db.select().from(prizeFulfilments).where(eq(prizeFulfilments.partyId, goodsId))).map((f) => f.winnerUserId)).toEqual([runnerUp.id]);
  });
});

