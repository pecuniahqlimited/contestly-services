/**
 * Stakes against the running stack: the limits endpoint, every refusal checkStakes makes, the host's cash prize held at
 * creation, paid out by place with no rake and released on cancel, and a brand's goods awarded one fulfilment per place.
 * Rounds aren't played here (party-sim does that): a party is settled by writing ranks and queueing the worker's settle job.
 */
import { and, eq } from "drizzle-orm";
import { db, ledgerEntries, parties, partyPlayers, prizeFulfilments, sql } from "@contestly/db";
import { closeQueues, partyQueue } from "@contestly/queue";
import { kobo, type PartyLimitsResponse } from "@contestly/shared";
import { api, call, failureCount, inMinutes, ok, partyNetKobo, waitFor } from "./sim-lib.js";

const BRIEF = "Nigerian music history: Fela, highlife and the artists who built Afrobeats";
const base = { brief: BRIEF, startsAt: inMinutes(30), questionCount: 3, secondsPerQuestion: 5 };
const pooled = { ...base, title: "Stakes sim pooled", funding: "pooled", entryKobo: kobo(750), maxPlayers: 8, split: "70_30" };
const hostCash = { ...base, title: "Stakes sim host cash", funding: "host", entryKobo: 0, maxPlayers: 6, split: "70_30", prizeKind: "cash", hostPoolKobo: kobo(10_000) };
const goods = {
  ...base, title: "Stakes sim goods", funding: "host", entryKobo: 0, maxPlayers: 10, split: "60_30_10", prizeKind: "product",
  places: [{ text: "A PlayStation 5", valueKobo: kobo(900_000) }, { text: "Wireless headphones" }, { text: "A branded hoodie", valueKobo: kobo(25_000) }],
};
const partyJobs = partyQueue();

const userId = async (h: string) => (await api(h, "GET", "/me")).id as string;
const cashOf = async (h: string) => (await api(h, "GET", "/me")).wallet.cashKobo as number;

/** Ranks written straight to the seats (best first), then the worker's own settle job. */
async function settleWith(partyId: string, handles: string[]) {
  await db.update(parties).set({ status: "live", liveAt: new Date() }).where(eq(parties.id, partyId));
  for (const [i, h] of handles.entries()) {
    await db.update(partyPlayers).set({ rank: i + 1, score: 100 * (handles.length - i) }).where(and(eq(partyPlayers.partyId, partyId), eq(partyPlayers.userId, await userId(h))));
  }
  await partyJobs.add("settle", { kind: "settle", partyId }, { jobId: `stakes-sim-settle-${partyId}` });
  return waitFor(async () => (await db.select({ status: parties.status }).from(parties).where(eq(parties.id, partyId)))[0]?.status === "finished", { tries: 40 });
}

for (const h of ["tunde", "ada.o", "kemz", "jollofrepublic"]) await api(h, "POST", "/wallet/dev-topup", { nairaAmount: 20_000 });

console.log("==== limits ====");
const tunde = await api<PartyLimitsResponse>("tunde", "GET", "/parties/limits");
const brand = await api<PartyLimitsResponse>("jollofrepublic", "GET", "/parties/limits");
ok(tunde.limits.entryMinKobo === kobo(50) && tunde.limits.hostPrizeMinKobo === kobo(500) && tunde.limits.hostPrizeMaxKobo === kobo(500_000), "limits carry the defaults (entry from ₦50, host prize ₦500 to ₦500,000)");
ok(tunde.rakeBps === 1000, "limits carry the rake the pot preview takes");
ok(!tunde.canOfferGoods && brand.canOfferGoods, "only the verified brand may offer goods");

console.log("\n==== refusals ====");
const refusals: [string, string, object][] = [
  ["entry below the lowest", "entry_out_of_range", { ...pooled, entryKobo: kobo(20) }],
  ["entry above the highest", "entry_out_of_range", { ...pooled, entryKobo: kobo(20_000) }],
  ["host prize below the smallest", "host_prize_out_of_range", { ...hostCash, hostPoolKobo: kobo(400) }],
  ["host prize above the biggest", "host_prize_out_of_range", { ...hostCash, hostPoolKobo: kobo(600_000) }],
  ["seats above the most", "seats_out_of_range", { ...pooled, maxPlayers: 201 }],
  ["Top 3 with 3 seats", "split_needs_seats", { ...pooled, split: "60_30_10", maxPlayers: 3 }],
  ["goods from someone who isn't a verified brand", "prize_needs_verified_brand", goods],
];
for (const [label, error, body] of refusals) {
  const r = await call("tunde", "POST", "/parties", body);
  ok(r.status === 422 && r.body.error === error, `${label} → 422 ${error} (got ${r.status} ${JSON.stringify(r.body)})`);
}
const twoPrizes = await call("jollofrepublic", "POST", "/parties", { ...goods, places: goods.places.slice(0, 2) });
ok(twoPrizes.status === 422 && twoPrizes.body.error === "prizes_incomplete", `Top 3 goods with two prizes → prizes_incomplete (got ${JSON.stringify(twoPrizes.body)})`);
const half = await call("tunde", "POST", "/parties", { ...pooled, entryKobo: 7_550 });
ok(half.status === 400, `an entry that isn't whole naira is refused (${half.status})`);

console.log("\n==== pooled, custom entry ====");
const p = await api("tunde", "POST", "/parties", pooled);
ok(p.entryKobo === kobo(750) && p.splitId === "70_30", "a ₦750 entry and 70/30 are accepted");
// 1 seat × ₦750 = ₦750, less 10% = ₦675 → 70/30
ok(p.places.map((x: any) => x.amountKobo).join() === [kobo(472.5), kobo(202.5)].join(), `places are the pot right now after the rake (${p.places.map((x: any) => x.amountKobo)})`);

console.log("\n==== host cash prize: held, paid by place, released on cancel ====");
const before = await cashOf("tunde");
const h = await api("tunde", "POST", "/parties", hostCash);
ok((await cashOf("tunde")) === before - kobo(10_000), "the full prize is held from the host's cash at creation");
ok(h.places.map((x: any) => x.amountKobo).join() === [kobo(7_000), kobo(3_000)].join(), "places show 1st ₦7,000 · 2nd ₦3,000");
for (const who of ["ada.o", "kemz"]) await api(who, "POST", `/parties/${h.id}/join`);
ok(!!(await settleWith(h.id, ["kemz", "ada.o", "tunde"])), "the host cash party settled");
ok((await partyNetKobo(await userId("kemz"), h.id)) === kobo(7_000), "1st got ₦7,000");
ok((await partyNetKobo(await userId("ada.o"), h.id)) === kobo(3_000), "2nd got ₦3,000");
ok((await partyNetKobo(await userId("tunde"), h.id)) === -kobo(10_000), "the host paid exactly the prize");
const rake = await db.select().from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, `party_rake:${h.id}`));
ok(rake.length === 0, "no rake on a host's prize");

const beforeCancel = await cashOf("tunde");
const c = await api("tunde", "POST", "/parties", hostCash);
await partyJobs.add("start", { kind: "start", partyId: c.id }, { jobId: `stakes-sim-start-${c.id}` });
const cancelled = await waitFor(async () => (await db.select({ status: parties.status }).from(parties).where(eq(parties.id, c.id)))[0]?.status === "cancelled", { tries: 40 });
ok(!!cancelled, "a host cash party with only the host in is cancelled at start");
ok((await cashOf("tunde")) === beforeCancel, "the held prize is released in full on cancel");
ok((await partyNetKobo(await userId("tunde"), c.id)) === 0, "the cancelled party nets the host zero");

console.log("\n==== brand goods: three places, one fulfilment each ====");
const g = await api("jollofrepublic", "POST", "/parties", goods);
ok(g.prizeKind === "product" && g.places.length === 3 && g.places[0].text === "A PlayStation 5" && g.places[0].valueKobo === kobo(900_000), "the three prizes come back by place");
for (const who of ["tunde", "ada.o", "kemz"]) await api(who, "POST", `/parties/${g.id}/join`);
ok(!!(await settleWith(g.id, ["ada.o", "kemz", "tunde"])), "the goods party settled");
const awarded = await db.select().from(prizeFulfilments).where(eq(prizeFulfilments.partyId, g.id)).orderBy(prizeFulfilments.place);
ok(awarded.length === 3 && awarded.every((f) => f.status === "awarded"), "one fulfilment per winning place, each awarded");
ok(awarded[0].winnerUserId === (await userId("ada.o")) && awarded[0].prizeText === "A PlayStation 5" && awarded[0].prizeValueKobo === kobo(900_000), "1st gets the PlayStation, its value copied in");
ok(awarded[2].winnerUserId === (await userId("tunde")) && awarded[2].prizeText === "A branded hoodie", "3rd gets the hoodie");
ok((await partyNetKobo(await userId("jollofrepublic"), g.id)) === 0, "goods move no money");

await closeQueues(partyJobs);
await sql.end();
console.log(failureCount() ? `\n${failureCount()} check(s) failed` : "\nall stakes checks passed");
process.exit(failureCount() ? 1 : 0);
