/**
 * Admin essentials (roadmap 5a) against the real database: every admin route refuses non-admins; a ban
 * shuts every door; a cancel is idempotent and refunds exactly once; restore and retire do what they say
 * and are logged with their reason; question content stays hidden while an unstarted party holds it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import {
  adminActions, adminCancelParty, bankQuestions, db, ledger, ledgerAccounts, ledgerEntries, parties, partyPlayers, partyQuestions, sql, type User,
} from "@contestly/db";
import { EMBEDDING_DIM, kobo } from "@contestly/shared";
import { withSessionToken } from "../src/signin/account.js";
import { as, makeUser, tag, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let routes: { method: string; url: string }[];
let admin: User, member: User, guest: User, target: User;

const reason = { reason: "integration test" };
const ANY_ID = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  ({ app, routes } = await testApp());
  admin = await makeUser("admin", { isAdmin: true });
  member = await makeUser("member");
  guest = await makeUser("guest", { isGuest: true, email: null, emailVerifiedAt: null });
  target = await makeUser("target");
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

const adminRoutes = () => routes.filter((r) => r.url.startsWith("/admin") && r.method !== "HEAD" && r.method !== "OPTIONS");
const fill = (url: string) => url.replace(":day", "2031-01-01").replace(/:[a-z]+/gi, ANY_ID);

describe("permissions", () => {
  it("there are admin routes to check", () => expect(adminRoutes().length).toBeGreaterThan(20));

  it("every admin route refuses a signed-up non-admin with 403, before reading the body", async () => {
    for (const r of adminRoutes()) {
      const res = await app.inject({ method: r.method as never, url: fill(r.url), headers: as(member), payload: r.method === "GET" ? undefined : {} });
      expect.soft(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect.soft(res.json().error, `${r.method} ${r.url}`).toBe("admin_only");
    }
  });

  it("every admin route refuses a guest and a request with no session", async () => {
    for (const r of adminRoutes()) {
      const asGuest = await app.inject({ method: r.method as never, url: fill(r.url), headers: as(guest), payload: r.method === "GET" ? undefined : {} });
      expect.soft(asGuest.statusCode, `guest ${r.method} ${r.url}`).toBe(403);
      const anonymous = await app.inject({ method: r.method as never, url: fill(r.url), payload: r.method === "GET" ? undefined : {} });
      expect.soft(anonymous.statusCode, `no session ${r.method} ${r.url}`).toBe(401);
    }
  });

  it("an admin gets in", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/session", headers: as(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json().admin.id).toBe(admin.id);
  });
});

describe("ban", () => {
  it("needs a reason, and an admin can't ban themselves", async () => {
    expect((await app.inject({ method: "POST", url: `/admin/users/${target.id}/ban`, headers: as(admin), payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/admin/users/${admin.id}/ban`, headers: as(admin), payload: reason })).json().error).toBe("cannot_ban_self");
  });

  it("shuts every door: the API, sign-in, joining and hosting", async () => {
    const [open] = await db.insert(parties).values({ createdByUserId: member.id, title: `ban test ${tag}`, category: "General knowledge", maxPlayers: 6, funding: "pooled", split: [100], startsAt: new Date(Date.now() + 3_600_000) }).returning();
    const banned = await app.inject({ method: "POST", url: `/admin/users/${target.id}/ban`, headers: as(admin), payload: reason });
    expect(banned.statusCode).toBe(200);
    expect(banned.json().user.bannedAt).not.toBeNull();
    expect(banned.json().user.banReason).toBe(reason.reason);

    for (const [method, url] of [["GET", "/me"], ["POST", `/parties/${open.id}/join`], ["POST", "/parties"], ["POST", "/climb/runs"]] as const) {
      const res = await app.inject({ method, url, headers: as(target), payload: method === "POST" ? {} : undefined });
      expect.soft(res.statusCode, `${method} ${url}`).toBe(403);
      expect.soft(res.json().error, `${method} ${url}`).toBe("account_banned");
    }
    // Any sign-in that lands on the account (email code, Google, Apple) is refused before a token is minted.
    await expect(withSessionToken({ userId: target.id, account: "existing", onboardingBonus: "none", bonusKobo: 0 })).rejects.toMatchObject({ statusCode: 403, message: "account_banned" });

    const [{ n }] = await db.select({ n: count() }).from(adminActions).where(and(eq(adminActions.targetId, target.id), eq(adminActions.action, "user.ban")));
    expect(Number(n)).toBe(1);
    // Banning again changes nothing and logs nothing.
    await app.inject({ method: "POST", url: `/admin/users/${target.id}/ban`, headers: as(admin), payload: reason });
    const [{ n: again }] = await db.select({ n: count() }).from(adminActions).where(and(eq(adminActions.targetId, target.id), eq(adminActions.action, "user.ban")));
    expect(Number(again)).toBe(1);
  });

  it("unban lets them back in", async () => {
    expect((await app.inject({ method: "POST", url: `/admin/users/${target.id}/unban`, headers: as(admin), payload: reason })).json().user.bannedAt).toBeNull();
    expect((await app.inject({ method: "GET", url: "/me", headers: as(target) })).statusCode).toBe(200);
  });

  it("finds users by email, @handle and id", async () => {
    for (const q of [target.email!, `@${target.handle}`, target.id]) {
      const res = await app.inject({ method: "GET", url: `/admin/users?q=${encodeURIComponent(q)}`, headers: as(admin) });
      expect.soft(res.json().users.map((u: { id: string }) => u.id), q).toContain(target.id);
    }
  });
});

describe("cancel", () => {
  it("is idempotent and refunds exactly once, through the worker's cancel path", async () => {
    const entry = kobo(100);
    const [p] = await db.insert(parties).values({ createdByUserId: member.id, title: `cancel test ${tag}`, category: "General knowledge", maxPlayers: 6, funding: "pooled", entryKobo: entry, split: [100], startsAt: new Date(Date.now() + 3_600_000) }).returning();
    await db.transaction(async (tx) => {
      await ledger.post(tx, { userId: target.id, kind: "cash", amountKobo: entry, type: "topup", idempotencyKey: `test:topup:${p.id}` });
      await ledger.charge(tx, { userId: target.id, amountKobo: entry, type: "party_entry", refType: "party", refId: p.id, idempotencyKey: `party_entry:${p.id}:${target.id}` });
      await tx.insert(partyPlayers).values({ partyId: p.id, userId: target.id });
    });

    expect((await app.inject({ method: "POST", url: `/admin/parties/${p.id}/cancel`, headers: as(admin), payload: {} })).statusCode).toBe(400); // a reason is required
    const first = await app.inject({ method: "POST", url: `/admin/parties/${p.id}/cancel`, headers: as(admin), payload: reason });
    expect(first.json()).toEqual({ status: "cancelling", replayed: false });
    const second = await app.inject({ method: "POST", url: `/admin/parties/${p.id}/cancel`, headers: as(admin), payload: reason });
    expect(second.json()).toEqual({ status: "cancelling", replayed: true });

    // The worker's path, run twice here (the queued job may run it too): it cancels once.
    await db.transaction((tx) => adminCancelParty(tx, p.id));
    const again = await db.transaction((tx) => adminCancelParty(tx, p.id));
    expect(again.cancelled).toBe(false);

    const [party] = await db.select().from(parties).where(eq(parties.id, p.id));
    expect(party.status).toBe("cancelled");
    const moves = await db.select({ type: ledgerEntries.type, amount: ledgerEntries.amountKobo }).from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
      .where(and(eq(ledgerAccounts.userId, target.id), eq(ledgerEntries.refType, "party"), eq(ledgerEntries.refId, p.id)));
    expect(moves.filter((m) => m.type === "party_refund")).toHaveLength(1);
    expect(moves.reduce((a, m) => a + Number(m.amount), 0)).toBe(0);

    expect((await app.inject({ method: "POST", url: `/admin/parties/${p.id}/cancel`, headers: as(admin), payload: reason })).json()).toEqual({ status: "cancelled", replayed: true });
    const [{ n }] = await db.select({ n: count() }).from(adminActions).where(and(eq(adminActions.targetId, p.id), eq(adminActions.action, "party.cancel")));
    expect(Number(n)).toBe(1);
  });
});

describe("question queue", () => {
  const payload = { question: `Integration test question ${tag}?`, options: ["A", "B", "C", "D"], correctIndex: 0 };
  const newQuestion = async (extra: Partial<typeof bankQuestions.$inferInsert> = {}) => {
    const [q] = await db.insert(bankQuestions).values({ format: "pick_one", payload, categoryTag: "General knowledge", embedding: Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === 7 ? 1 : 0)), difficulty: 0.3, origin: "test", status: "pending_review", flagCount: 4, ...extra }).returning();
    return q;
  };

  it("restore puts a voided question back with its flags cleared, and is logged with its reason", async () => {
    const q = await newQuestion();
    expect((await app.inject({ method: "POST", url: `/admin/questions/${q.id}/restore`, headers: as(admin), payload: {} })).statusCode).toBe(400);
    const res = await app.inject({ method: "POST", url: `/admin/questions/${q.id}/restore`, headers: as(admin), payload: reason });
    expect(res.statusCode).toBe(200);
    expect(res.json().question).toMatchObject({ status: "active", flagCount: 0 });
    expect(res.json().actions[0]).toMatchObject({ action: "question.restore", reason: reason.reason, before: { status: "pending_review", flagCount: 4 } });
  });

  it("an admin retire is permanent: no restore, no edit", async () => {
    const q = await newQuestion();
    const retired = await app.inject({ method: "POST", url: `/admin/questions/${q.id}/retire`, headers: as(admin), payload: reason });
    expect(retired.json().question).toMatchObject({ status: "retired", retiredReason: "admin" });
    expect((await app.inject({ method: "POST", url: `/admin/questions/${q.id}/restore`, headers: as(admin), payload: reason })).json().error).toBe("retired_permanently");
    expect((await app.inject({ method: "POST", url: `/admin/questions/${q.id}/edit`, headers: as(admin), payload: { payload, claim: "A is right", ...reason } })).json().error).toBe("retired_permanently");
    await app.inject({ method: "POST", url: `/admin/questions/${q.id}/retire`, headers: as(admin), payload: reason });
    const [{ n }] = await db.select({ n: count() }).from(adminActions).where(and(eq(adminActions.targetId, q.id), eq(adminActions.action, "question.retire")));
    expect(Number(n)).toBe(1);
  });

  it("a sweep-retired question can be restored", async () => {
    const q = await newQuestion({ status: "retired", retiredReason: "flagged", retiredAt: new Date() });
    expect((await app.inject({ method: "POST", url: `/admin/questions/${q.id}/restore`, headers: as(admin), payload: reason })).json().question.status).toBe("active");
  });

  it("an edit must fit the question's format", async () => {
    const q = await newQuestion();
    const res = await app.inject({ method: "POST", url: `/admin/questions/${q.id}/edit`, headers: as(admin), payload: { payload: { question: "x" }, claim: "nothing", ...reason } });
    expect(res.json().error).toBe("invalid_payload");
  });

  it("hides content while a party that hasn't started holds the question", async () => {
    const q = await newQuestion();
    const [p] = await db.insert(parties).values({ createdByUserId: member.id, title: `sealed ${tag}`, category: "General knowledge", maxPlayers: 6, funding: "pooled", split: [100], startsAt: new Date(Date.now() + 3_600_000) }).returning();
    await db.insert(partyQuestions).values({ partyId: p.id, idx: 0, format: "pick_one", payload, seconds: 15, sourceRef: q.id });
    const res = await app.inject({ method: "GET", url: `/admin/questions/${q.id}`, headers: as(admin) });
    expect(res.json().question).toMatchObject({ payload: null, explanation: null, inUnstartedParty: true });
    expect(res.json().generation).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/admin/questions/${q.id}/edit`, headers: as(admin), payload: { payload, claim: "A is right", ...reason } })).json().error).toBe("in_unstarted_party");
  });
});

describe("onboarding config", () => {
  it("is versioned, validated, logged, and what /onboarding/rewards serves", async () => {
    const current = (await app.inject({ method: "GET", url: "/admin/onboarding", headers: as(admin) })).json();
    const unordered = { ...current.config, soloTiers: [{ minPoints: 100, coinsKobo: 1 }, { minPoints: 500, coinsKobo: 2 }] };
    expect((await app.inject({ method: "PUT", url: "/admin/onboarding", headers: as(admin), payload: { config: unordered } })).statusCode).toBe(400);
    const next = { ...current.config, sharedByRankKobo: [kobo(600), kobo(300)] };
    const saved = (await app.inject({ method: "PUT", url: "/admin/onboarding", headers: as(admin), payload: { config: next, reason: "test" } })).json();
    expect(saved.version).toBeGreaterThan(current.version ?? 0);
    expect((await app.inject({ method: "GET", url: "/onboarding/rewards" })).json().sharedByRankKobo).toEqual([kobo(600), kobo(300)]);
    await app.inject({ method: "PUT", url: "/admin/onboarding", headers: as(admin), payload: { config: current.config, reason: "test: put it back" } });
  });
});
