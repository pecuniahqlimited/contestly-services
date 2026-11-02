/**
 * Admin alerts: adminAlert() records and dedupes (a repeat of the key in its window bumps the count; after
 * the window or an acknowledge, a new row; inside a transaction that rolls back, nothing), and the worker's
 * delivery sends by severity (critical at once by email and webhook, warning in the email digest, info
 * never), throttles a storm per kind ("and N more"), keeps a failing channel from holding up the other, and
 * stops for an acknowledged alert. The console lists, filters, acknowledges with a note (logged) and counts
 * open criticals for the home. The email provider and the webhook are fakes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminActions, adminAlert, adminAlerts, db, sql, type User } from "@contestly/db";
import type { EmailMessage, EmailSender } from "@contestly/email";
import { deliverAlerts, emailChannel, webhookChannel, type AlertDeliveryConfig, type DeliveryReport } from "../../worker/src/alertDelivery.js";
import { as, makeUser, tag, testApp } from "./harness.js";

const CFG: AlertDeliveryConfig = { digestMinutes: 30, throttleMinutes: 10, listMax: 5, retryMinutes: 1 };
const MIN = 60_000;
const PREFIX = `t${tag}_`;
let seq = 0;
/** A kind of this run's own (delivery is scoped to this run's prefix, so nothing else in the database shows up). */
const kind = (name: string) => `${PREFIX}${name}`;
const key = () => `${PREFIX}key${++seq}`;

/**
 * One test's own world: kinds under its own prefix (delivery is scoped to it, so nothing else in the database
 * shows up), and a fake email provider and webhook that record what they were given; either can fail.
 */
function fakes() {
  const mail: EmailMessage[] = [];
  const hooks: { text: string }[] = [];
  const state = { mailFails: false, hookFails: false };
  const sender: EmailSender = { name: "zeptomail", send: async (m) => { if (state.mailFails) throw new Error("provider down"); mail.push(m); } };
  const n = ++seq;
  const prefix = `${PREFIX}${n}_`;
  const email = emailChannel({ name: `email-${tag}-${n}`, recipients: ["ops@example.test"], senders: { zeptomail: sender }, primary: async () => "zeptomail", log: async () => {} });
  const fetchFake = (async (_url: string, init: RequestInit) => {
    if (state.hookFails) return new Response("no", { status: 500 });
    hooks.push(JSON.parse(String(init.body)));
    return new Response("ok");
  }) as typeof fetch;
  const webhook = (severities: ("warning" | "critical")[] = ["critical"]) => webhookChannel({ name: `webhook-${tag}-${n}`, url: "https://hooks.example.test/x", severities, fetch: fetchFake });
  return { mail, hooks, state, email, webhook, prefix, kind: (name: string) => `${prefix}${name}` };
}

/** A pass at `at`, scoped to the test's kinds. Retries if another worker held the delivery lock at that instant. */
async function deliver(f: { prefix: string }, channels: Parameters<typeof deliverAlerts>[0], at: Date): Promise<DeliveryReport[]> {
  for (let i = 0; i < 20; i++) {
    const r = await deliverAlerts(channels, CFG, { now: at, kindPrefix: f.prefix });
    if (r) return r;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("delivery lock never free");
}
const later = (ms: number) => new Date(Date.now() + ms);
const rowsOf = (k: string) => db.select().from(adminAlerts).where(eq(adminAlerts.kind, k));

let admin: User;
let app: Awaited<ReturnType<typeof testApp>>["app"];
beforeAll(async () => {
  admin = await makeUser("alertadm", { isAdmin: true });
  app = (await testApp()).app;
});
afterAll(async () => {
  await app.close();
  await sql.end();
});

describe("adminAlert(): stored and deduped", () => {
  it("the same key in its window bumps the count; another key is another row", async () => {
    const k = kind("dedupe"), dk = key();
    const first = await adminAlert({ kind: k, severity: "warning", subject: "one", details: { n: 1 }, dedupeKey: dk });
    const again = await adminAlert({ kind: k, severity: "warning", subject: "one, again", details: { n: 2 }, dedupeKey: dk });
    expect(first).toMatchObject({ isNew: true, count: 1 });
    expect(again).toEqual({ id: first.id, isNew: false, count: 2 });
    const [row] = await rowsOf(k);
    expect(row).toMatchObject({ count: 2, subject: "one, again", details: { n: 2 } });
    expect(row.lastSeenAt.getTime()).toBeGreaterThanOrEqual(row.firstSeenAt.getTime());
    expect((await adminAlert({ kind: k, severity: "warning", subject: "two", details: {}, dedupeKey: key() })).isNew).toBe(true);
    expect(await rowsOf(k)).toHaveLength(2);
  });

  it("raised at once from many places: one row, every one counted", async () => {
    const k = kind("race"), dk = key();
    await Promise.all(Array.from({ length: 20 }, () => adminAlert({ kind: k, severity: "critical", subject: "s", details: {}, dedupeKey: dk })));
    const rows = await rowsOf(k);
    expect(rows.map((r) => r.count)).toEqual([20]);
  });

  it("after its window, or once acknowledged, the same key is a new alert", async () => {
    const k = kind("window"), dk = key();
    const a = await adminAlert({ kind: k, severity: "info", subject: "s", details: {}, dedupeKey: dk, dedupeWindowSeconds: 60 });
    await db.update(adminAlerts).set({ windowEndsAt: new Date(Date.now() - 1000) }).where(eq(adminAlerts.id, a.id)); // TEST-ONLY: the window has passed
    const b = await adminAlert({ kind: k, severity: "info", subject: "s", details: {}, dedupeKey: dk });
    expect(b.isNew).toBe(true);
    await app.inject({ method: "POST", url: `/admin/alerts/${b.id}/ack`, headers: as(admin), payload: { note: "looked, fine" } });
    const c = await adminAlert({ kind: k, severity: "info", subject: "s", details: {}, dedupeKey: dk });
    expect(c.isNew).toBe(true);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("raised inside a transaction that rolls back: no alert", async () => {
    const k = kind("rollback");
    await db.transaction(async (tx) => {
      await adminAlert({ kind: k, severity: "critical", subject: "s", details: {}, dedupeKey: key() }, tx);
      tx.rollback();
    }).catch(() => {});
    expect(await rowsOf(k)).toEqual([]);
  });
});

describe("delivery by severity", () => {
  it("critical: email and webhook at once; info: nothing anywhere; warning: not at once, and never to a critical-only webhook", async () => {
    const f = fakes();
    const channels = [f.email, f.webhook()];
    await adminAlert({ kind: f.kind("pay_stuck"), severity: "critical", subject: "Payout stuck", details: { payoutId: "p1" }, dedupeKey: key(), refType: "payout", refId: "p1" });
    await adminAlert({ kind: f.kind("fyi"), severity: "info", subject: "FYI", details: {}, dedupeKey: key() });
    await adminAlert({ kind: f.kind("velocity"), severity: "warning", subject: "Busy hour", details: {}, dedupeKey: key() });

    await deliver(f, channels, new Date());
    expect(f.mail.map((m) => m.subject)).toEqual(["[Contestly] CRITICAL: Payout stuck"]);
    expect(f.mail[0].to).toBe("ops@example.test");
    expect(f.mail[0].text).toContain("payout: p1");
    expect(f.hooks).toHaveLength(1);
    expect(f.hooks[0].text).toMatch(/^\*\[Contestly\] CRITICAL: Payout stuck\*\n/); // Slack-compatible { text }

    await deliver(f, channels, later(CFG.digestMinutes * MIN + MIN)); // the digest is due: the warning goes, by email only
    expect(f.mail.map((m) => m.subject)).toEqual(["[Contestly] CRITICAL: Payout stuck", "[Contestly] Warnings: 1 occurrence of 1 kind"]);
    expect(f.hooks).toHaveLength(1);
    expect([...f.mail, ...f.hooks].some((m) => m.text.includes("FYI"))).toBe(false);
  });

  it("a webhook set to warning gets the digest too", async () => {
    const f = fakes();
    await adminAlert({ kind: f.kind("recon"), severity: "warning", subject: "Recon differences", details: {}, dedupeKey: key() });
    await deliver(f, [f.webhook(["warning", "critical"])], later(CFG.digestMinutes * MIN + MIN));
    expect(f.hooks.map((h) => h.text.split("\n")[0])).toEqual(["*[Contestly] Warnings: 1 occurrence of 1 kind*"]);
  });
});

describe("the warning digest", () => {
  it("waits its interval, then one message for every kind; after it, the next waits a full interval again", async () => {
    const f = fakes();
    const [a, b] = [f.kind("dg_a"), f.kind("dg_b")];
    await adminAlert({ kind: a, severity: "warning", subject: "A one", details: {}, dedupeKey: key() });
    await adminAlert({ kind: a, severity: "warning", subject: "A two", details: {}, dedupeKey: key() });
    const repeated = key();
    for (let i = 0; i < 3; i++) await adminAlert({ kind: b, severity: "warning", subject: "B", details: {}, dedupeKey: repeated });

    await deliver(f, [f.email], later(5 * MIN));
    expect(f.mail).toHaveLength(0); // not yet: warnings wait for the digest
    const first = later(CFG.digestMinutes * MIN + MIN);
    await deliver(f, [f.email], first);
    expect(f.mail).toHaveLength(1);
    expect(f.mail[0].subject).toBe("[Contestly] Warnings: 5 occurrences of 2 kinds");
    expect(f.mail[0].text).toContain(`${b}: 3 occurrences`);
    expect(f.mail[0].text).toContain("• B (×3)");
    expect(f.mail[0].text).toContain(`${a}: 2 occurrences`);

    await deliver(f, [f.email], new Date(first.getTime() + MIN));
    expect(f.mail).toHaveLength(1); // nothing new
    await adminAlert({ kind: a, severity: "warning", subject: "A three", details: {}, dedupeKey: key() });
    await deliver(f, [f.email], new Date(first.getTime() + 10 * MIN));
    expect(f.mail).toHaveLength(1); // inside the interval since the last digest
    await deliver(f, [f.email], new Date(first.getTime() + CFG.digestMinutes * MIN + MIN));
    expect(f.mail).toHaveLength(2);
    expect(f.mail[1].text).toContain("A three");
    expect(f.mail[1].text).not.toContain("A one");
  });
});

describe("throttle per kind", () => {
  it("a storm of one kind: one message at once, then one per interval saying how many more; other kinds aren't held up", async () => {
    const f = fakes();
    const storm = f.kind("storm");
    await adminAlert({ kind: storm, severity: "critical", subject: "Payout unknown: 0", details: {}, dedupeKey: key() });
    const t0 = new Date();
    await deliver(f, [f.email], t0);
    expect(f.mail).toHaveLength(1);

    for (let i = 1; i <= 317; i++) await adminAlert({ kind: storm, severity: "critical", subject: `Payout unknown: ${i}`, details: { i }, dedupeKey: key() });
    await adminAlert({ kind: f.kind("other"), severity: "critical", subject: "Something else", details: {}, dedupeKey: key() });
    await deliver(f, [f.email], new Date(t0.getTime() + MIN));
    expect(f.mail.map((m) => m.subject)).toEqual(["[Contestly] CRITICAL: Payout unknown: 0", "[Contestly] CRITICAL: Something else"]); // the storm waits; the other kind doesn't

    await deliver(f, [f.email], new Date(t0.getTime() + CFG.throttleMinutes * MIN));
    expect(f.mail).toHaveLength(3);
    expect(f.mail[2].subject).toBe(`[Contestly] CRITICAL: ${storm} (317 new)`);
    expect(f.mail[2].text).toContain("• Payout unknown: 1\n");
    expect(f.mail[2].text).toContain("• Payout unknown: 5\n");
    expect(f.mail[2].text).not.toContain("Payout unknown: 6\n");
    expect(f.mail[2].text).toContain("…and 312 more");

    await deliver(f, [f.email], new Date(t0.getTime() + 3 * CFG.throttleMinutes * MIN));
    expect(f.mail).toHaveLength(3); // all delivered: nothing repeats
  });

  it("one key repeated a thousand times is one alert, sent once with its count", async () => {
    const f = fakes();
    const k = f.kind("loop"), dk = key();
    for (let i = 0; i < 1000; i++) await adminAlert({ kind: k, severity: "critical", subject: "Webhook rejected", details: {}, dedupeKey: dk });
    await deliver(f, [f.email], new Date());
    expect(f.mail.map((m) => m.subject)).toEqual([`[Contestly] CRITICAL: ${k} (1000 new)`]);
    expect(f.mail[0].text).toContain("• Webhook rejected (×1000)");
  });
});

describe("failures", () => {
  it("a failing webhook doesn't hold up email; it's retried after the wait and then gets what it missed", async () => {
    const f = fakes();
    const channels = [f.email, f.webhook()];
    f.state.hookFails = true;
    await adminAlert({ kind: f.kind("fail"), severity: "critical", subject: "Freeze", details: {}, dedupeKey: key() });
    const t0 = new Date();
    const r = await deliver(f, channels, t0);
    expect(r.map((x) => [x.channel.split("-")[0], x.ok])).toEqual([["email", true], ["webhook", false]]);
    expect(f.mail).toHaveLength(1);
    f.state.hookFails = false;
    await deliver(f, channels, new Date(t0.getTime() + 10_000));
    expect(f.hooks).toHaveLength(0); // inside the retry wait
    await deliver(f, channels, new Date(t0.getTime() + CFG.retryMinutes * MIN));
    expect(f.hooks).toHaveLength(1);
    expect(f.mail).toHaveLength(1); // email already had it
  });
});

describe("the console", () => {
  it("lists with filters, acknowledges with a note (logged, once), and the home counts open criticals", async () => {
    const f = fakes();
    const k = f.kind("console");
    const crit = await adminAlert({ kind: k, severity: "critical", subject: "Invariant breach", details: { what: "x" }, dedupeKey: key() });
    await adminAlert({ kind: k, severity: "warning", subject: "Velocity", details: {}, dedupeKey: key() });
    const get = (url: string) => app.inject({ method: "GET", url, headers: as(admin) });

    const list = (await get(`/admin/alerts?kind=${k}`)).json().alerts;
    expect(list.map((a: { severity: string }) => a.severity).sort()).toEqual(["critical", "warning"]);
    expect((await get(`/admin/alerts?kind=${k}&severity=critical`)).json().alerts.map((a: { id: string }) => a.id)).toEqual([crit.id]);
    const openBefore = (await get("/admin/alerts/summary")).json().open.critical;
    expect(openBefore).toBeGreaterThanOrEqual(1);

    const ack = (note: string) => app.inject({ method: "POST", url: `/admin/alerts/${crit.id}/ack`, headers: as(admin), payload: { note } });
    expect((await ack("")).statusCode).toBe(400); // a note is required
    const done = await ack("Checked with Paystack: settled.");
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ replayed: false, alert: { id: crit.id, ackNote: "Checked with Paystack: settled.", acknowledgedBy: { id: admin.id } } });
    expect((await ack("again")).json()).toMatchObject({ replayed: true, alert: { ackNote: "Checked with Paystack: settled." } });
    const logged = await db.select().from(adminActions).where(and(eq(adminActions.targetType, "alert"), eq(adminActions.targetId, crit.id)));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ action: "alert.acknowledge", adminUserId: admin.id, reason: "Checked with Paystack: settled." });

    expect((await get(`/admin/alerts?kind=${k}`)).json().alerts.map((a: { severity: string }) => a.severity)).toEqual(["warning"]); // open by default
    expect((await get(`/admin/alerts?kind=${k}&state=acknowledged`)).json().alerts.map((a: { id: string }) => a.id)).toEqual([crit.id]);
    expect((await get("/admin/alerts/summary")).json().open.critical).toBe(openBefore - 1);

    await deliver(f, [f.email], new Date());
    expect(f.mail.some((m) => m.subject.includes("Invariant breach"))).toBe(false); // acknowledged before delivery: not sent

    const notAdmin = await makeUser("alertnope");
    expect((await app.inject({ method: "GET", url: "/admin/alerts", headers: as(notAdmin) })).statusCode).toBe(403);
  });
});
