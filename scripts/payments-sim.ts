/**
 * Payments end to end against the running stack with the mock provider (row 10, ADR 0013):
 *
 * 1. A top-up: POST /wallet/topups, "pay" on the mock checkout (its signed webhook goes through the real
 *    ingest), the worker verifies and credits; polling never credited anything itself. A doubled webhook
 *    still credits once. A declined card isn't the end: the top-up stays pending (attemptFailed) and paying
 *    on the same checkout credits it.
 * 2. A withdrawal: phone verified, a bank account resolved and confirmed by name, a withdrawal debited at
 *    once and sent by the worker; one the provider refuses comes back exactly once; one whose send timed out
 *    is checked (never resent blind) and settles.
 * 3. The console: the overview; raising a limit waits for a second admin, who confirms it; lowering it back
 *    is one admin; the invariant checks find nothing.
 *
 * TEST-ONLY: marks the sim user's phone verified, and a second sim admin, straight in Postgres. Run with the stack up (and the mock
 * provider, the dev default): npm run sim:payments
 */
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { eq } from "drizzle-orm";
import { db, sql, users } from "@contestly/db";
import { kobo } from "@contestly/shared";
import { API, api, call, failureCount, ok, putBack, putBackLater, waitFor } from "./sim-lib.js";

const tag = randomBytes(3).toString("hex");
const ME = `pay.${tag}`;
const ADMIN = "tunde";
const cash = async () => ((await api(ME, "GET", "/wallet")) as { cashKobo: number }).cashKobo;

console.log(`— top-up (${ME})`);
const t = await api(ME, "POST", "/wallet/topups", { amountKobo: kobo(5000) + 27 }); // the mock delivers this webhook twice
ok(t.status === "pending" && t.reference.startsWith("tp-"), `pending top-up ${t.reference}`);
ok((await api(ME, "GET", `/wallet/topups/${t.reference}`)).status === "pending" && (await cash()) === 0, "polling alone credits nothing");
const paid = await fetch(`${API}/payments/mock/checkout/${t.reference}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pay" }) }).then((r) => r.json());
ok(paid.deliveries?.length === 2 && paid.deliveries.every((d: string) => d === "accepted"), "the mock checkout's two webhook deliveries were accepted");
const credited = await waitFor(async () => (await api(ME, "GET", `/wallet/topups/${t.reference}`)).status === "succeeded", { tries: 40 });
ok(!!credited, "the worker verified and credited it");
ok((await cash()) === kobo(5000) + 27, "credited exactly once");

const retry = await api(ME, "POST", "/wallet/topups", { amountKobo: kobo(1000) });
const checkout = (action: "pay" | "fail") => fetch(`${API}/payments/mock/checkout/${retry.reference}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }).then((r) => r.json());
await checkout("fail");
const declined = await waitFor(async () => { const v = await api(ME, "GET", `/wallet/topups/${retry.reference}`); return v.attemptFailed ? v : null; }, { tries: 40 });
ok(declined?.status === "pending" && declined?.checkoutUrl === retry.checkoutUrl, "a declined card leaves it pending, same checkout, attemptFailed");
await checkout("pay");
ok(await waitFor(async () => (await api(ME, "GET", `/wallet/topups/${retry.reference}`)).status === "succeeded", { tries: 40 }) !== null, "paid on the same checkout after the decline: credited");
ok((await cash()) === kobo(5000) + 27 + kobo(1000), "both top-ups credited exactly once");

console.log("— withdrawals");
const tooEarly = await call(ME, "POST", "/wallet/withdrawals", { amountKobo: kobo(1500), bankAccountId: randomUUID(), clientRequestId: randomUUID() });
ok(tooEarly.status === 403 && (tooEarly.body as any).details?.reason === "phone_unverified", "no verified phone: withdraw_not_allowed (phone_unverified)");
await db.update(users).set({ phone: `+2348${Date.now().toString().slice(-9)}`, phoneVerifiedAt: new Date() }).where(eq(users.handle, ME));
const banks = (await api(ME, "GET", "/wallet/banks")).banks as { code: string; name: string }[];
ok(banks.length > 0, `${banks.length} banks`);
const resolved = await api(ME, "POST", "/wallet/bank-accounts/resolve", { bankCode: banks[0].code, accountNumber: "0123456789" });
ok(/MOCK HOLDER/.test(resolved.accountName), `resolved to ${resolved.accountName}`);
const wrongName = await call(ME, "POST", "/wallet/bank-accounts", { resolveToken: resolved.resolveToken, accountName: "Someone Else" });
ok(wrongName.status === 422 && (wrongName.body as any).error === "account_name_mismatch", "a name that isn't the bank's is refused");
const saved = (await api(ME, "POST", "/wallet/bank-accounts", { resolveToken: resolved.resolveToken, accountName: resolved.accountName })).accounts[0];
ok(saved.usable && saved.accountNumberLast4 === "6789", "account saved");

const withdraw = (amountKobo: number) => api(ME, "POST", "/wallet/withdrawals", { amountKobo, bankAccountId: saved.id, clientRequestId: randomUUID() });
const statusOf = async (id: string) => ((await api(ME, "GET", "/wallet/withdrawals")).payouts as { id: string; status: string }[]).find((p) => p.id === id)?.status;
const before = await cash();
const okOne = (await withdraw(kobo(1500))).payout;
ok(okOne.status === "requested" && (await cash()) === before - kobo(1500), "debited at once, before anything is sent");
const refused = (await withdraw(kobo(1500) + 11)).payout; // the mock's bank refuses it
const slow = (await withdraw(kobo(1500) + 14)).payout; // the send times out, but the transfer went through
ok(await waitFor(async () => (await statusOf(okOne.id)) === "succeeded", { tries: 60 }) !== null, "sent and settled");
ok(await waitFor(async () => (await statusOf(refused.id)) === "failed", { tries: 60 }) !== null, "a refused transfer fails");
ok(await waitFor(async () => (await statusOf(slow.id)) === "unknown", { tries: 60 }) !== null, "a timed-out send is unknown, not failed");
const settled = await waitFor(async () => (await statusOf(slow.id)) === "succeeded", { tries: 75, everyMs: 2000 });
ok(!!settled, "the unknown one is checked by the sweep and settles");
ok((await cash()) === before - kobo(1500) - (kobo(1500) + 14), "the refused one came back exactly once; the others stay paid out");
const [{ sends }] = await sql`select send_attempts as sends from payouts where id = ${slow.id}`;
ok(Number(sends) === 1, "the timed-out one was never sent twice");

console.log("— console");
const overview = await api(ADMIN, "GET", "/admin/payments");
ok(overview.providers.configured.includes("mock") && overview.settings.collections === "mock", "overview: mock provider");
const ADMIN2 = `payadm.${tag}`;
await api(ADMIN2, "GET", "/me");
await db.update(users).set({ isAdmin: true }).where(eq(users.handle, ADMIN2));
const cfg = (await api(ADMIN, "GET", "/admin/payments/config")).config;
// Lowering back is one admin (it tightens), so the put-back needs no second admin, even after a failure.
putBackLater("the payments config", async () => {
  if (!same((await api(ADMIN, "GET", "/admin/payments/config")).config, cfg)) await api(ADMIN, "PUT", "/admin/payments/config", { config: cfg, reason: "sim: put back as found" });
});
try {
  const raised = structuredClone(cfg);
  raised.payout.maxKobo += kobo(1000);
  const asked = await call(ADMIN, "PUT", "/admin/payments/config", { config: raised, reason: "sim: raise the max" });
  ok(asked.status === 202 && (asked.body as any).change?.loosens?.[0] === "payout.maxKobo", "raising a limit waits for a second admin");
  const self = await call(ADMIN, "POST", `/admin/payments/config-changes/${(asked.body as any).change.id}/confirm`);
  ok(self.status === 403, "not the same admin");
  ok((await api(ADMIN2, "POST", `/admin/payments/config-changes/${(asked.body as any).change.id}/confirm`)).change.status === "applied", "a second admin confirms it");
  const back = await call(ADMIN, "PUT", "/admin/payments/config", { config: cfg, reason: "sim: back to before" });
  ok(back.status === 200, "lowering it back is one admin");
  const inv = await api(ADMIN, "POST", "/admin/payments/invariants/run");
  ok(inv.breaches.length === 0, `invariants: ${inv.breaches.length ? JSON.stringify(inv.breaches) : "no breach"}`);
} finally {
  await putBack();
}

await sql.end();
console.log(failureCount() ? `\n${failureCount()} failure(s)` : "\npayments sim passed");
process.exit(failureCount() ? 1 : 0);
