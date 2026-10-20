/**
 * Demo data. Safe to re-run: the demo users (fixed IDs) are upserted back to their demo state and the follows
 * between them replaced. Each run opens three new demo parties, scheduled like any party the API creates: entries
 * and the host's prize go through the ledger, the sealed sets are queued now and the start jobs for startsAt.
 * Parties from earlier runs are left alone; the worker's sweep starts or cancels them once they're overdue.
 * Wallets are append-only: the one-off seed credits are posted once, and each seat or prize is topped up by
 * exactly what it costs, so a demo party's pot was really paid in.
 */
import { randomUUID } from "node:crypto";
import { and, inArray, sql as dsql } from "drizzle-orm";
import { kobo, WELCOME_BONUS_KOBO, DEFAULT_PAYOUT_CONFIG, DEFAULT_PARTY_CONFIG, DEFAULT_QUESTIONS_CONFIG } from "@contestly/shared";
import { closeQueues, partyQueue, questionsQueue } from "@contestly/queue";
import { db, sql, type Tx } from "./client.js";
import { users, follows, parties, partyPlayers, chatMessages, appConfig } from "./schema.js";
import * as ledger from "./ledger.js";

const uid = (n: number) => `00000000-0000-4000-8000-1000000000${String(n).padStart(2, "0")}`;

/** Credit a demo user exactly `amountKobo` of cash, then spend it the way the API would. */
const topUp = (tx: Tx, userId: string, amountKobo: number, key: string) =>
  ledger.post(tx, { userId, kind: "cash", amountKobo, type: "topup", idempotencyKey: `seed:topup:${key}` });

const people = [
  { id: uid(1), handle: "tunde", displayName: "Tunde Bakare", avatarEmoji: "🦁", bio: "Football head. I host a party every Friday night.", interests: ["Football", "General knowledge"], isBrand: false, isVerified: false },
  { id: uid(2), handle: "ada.o", displayName: "Ada Obi", avatarEmoji: "🦋", bio: "Law student. Trivia is my cardio.", interests: ["Afrobeats", "History"], isBrand: false, isVerified: false },
  { id: uid(3), handle: "kemz", displayName: "Kemi Adeyemi", avatarEmoji: "🌻", bio: "Nollywood encyclopedia.", interests: ["Nollywood", "Reality TV"], isBrand: false, isVerified: false },
  { id: uid(4), handle: "segunola", displayName: "Segun Ola", avatarEmoji: "⚡", bio: "Engineer by day, quiz goat by night.", interests: ["Tech", "Maths"], isBrand: false, isVerified: false },
  { id: uid(5), handle: "zee", displayName: "Zainab Musa", avatarEmoji: "🌙", bio: "Streaks are a lifestyle.", interests: ["Geography", "Fashion"], isBrand: false, isVerified: false },
  { id: uid(6), handle: "afrobeatsweekly", displayName: "Afrobeats Weekly", avatarEmoji: "🎶", bio: "Official account. The home of Afrobeats.", interests: ["Afrobeats"], isBrand: true, isVerified: true },
  { id: uid(7), handle: "jollofrepublic", displayName: "Jollof Republic", avatarEmoji: "🍛", bio: "Free-entry lunch parties every weekday.", interests: ["Food"], isBrand: true, isVerified: true },
];

const scheduled: { id: string; startsAt: Date }[] = [];
await db.transaction(async (tx) => {
  // Upsert on handle: a dev handle auto-created before seeding keeps its row (and id) but gets the demo profile back.
  const rows = await tx.insert(users).values(people).onConflictDoUpdate({
    target: users.handle,
    set: { displayName: dsql`excluded.display_name`, avatarEmoji: dsql`excluded.avatar_emoji`, bio: dsql`excluded.bio`, interests: dsql`excluded.interests`, isBrand: dsql`excluded.is_brand`, isVerified: dsql`excluded.is_verified`, streakDays: 0, lastPlayedOn: null },
  }).returning();
  const by = Object.fromEntries(rows.map((u) => [u.handle, u.id]));
  const demoUserIds = rows.map((u) => u.id);

  await tx.delete(follows).where(and(inArray(follows.followerId, demoUserIds), inArray(follows.followeeId, demoUserIds)));
  await tx.insert(follows).values([
    { followerId: by["ada.o"], followeeId: by["tunde"] },
    { followerId: by["kemz"], followeeId: by["tunde"] },
    { followerId: by["tunde"], followeeId: by["afrobeatsweekly"] },
    { followerId: by["zee"], followeeId: by["afrobeatsweekly"] },
  ]);

  for (const u of rows) {
    await ledger.post(tx, { userId: u.id, kind: "bonus", amountKobo: WELCOME_BONUS_KOBO, type: "welcome_bonus", idempotencyKey: `seed:welcome:${u.id}` });
    if (u.isBrand) await ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: kobo(200_000), type: "topup", idempotencyKey: `seed:brandcash:${u.id}` });
  }

  const soon = (m: number) => new Date(Date.now() + m * 60_000);
  const demoParties = [
    { id: randomUUID(), createdByUserId: by["afrobeatsweekly"], title: "Afrobeats 2010s throwback", brief: "2010s Afrobeats — the hits, the artists, the moments that made the decade", category: "Afrobeats", entryKobo: kobo(200), maxPlayers: 10, funding: "pooled" as const, hostPoolKobo: 0, split: [60, 30, 10], visibility: "public" as const, coverColor: "#7B5CFF", coverEmoji: "🎶", questionsStatus: "generating" as const, startsAt: soon(15) },
    { id: randomUUID(), createdByUserId: by["tunde"], title: "Friday night football", brief: "Football: Super Eagles history, Premier League and classic World Cup moments", category: "Football", entryKobo: kobo(500), maxPlayers: 6, funding: "pooled" as const, hostPoolKobo: 0, split: [70, 30], visibility: "public" as const, coverColor: "#0FA97A", coverEmoji: "⚽", questionsStatus: "generating" as const, startsAt: soon(30) },
    { id: randomUUID(), createdByUserId: by["jollofrepublic"], title: "Jollof Republic lunch break", brief: "Nigerian food: dishes, ingredients and which city claims them", category: "Food", entryKobo: 0, maxPlayers: 50, funding: "host" as const, hostPoolKobo: kobo(20_000), split: [50, 30, 20], visibility: "public" as const, coverColor: "#FF8A3D", coverEmoji: "🍛", questionsStatus: "generating" as const, startsAt: soon(60) },
  ];
  const [afro, football, jollof] = demoParties;
  await tx.insert(parties).values(demoParties);

  // The host's prize is held up front, as POST /parties does.
  await topUp(tx, jollof.createdByUserId, jollof.hostPoolKobo, `party_fund:${jollof.id}`);
  await ledger.post(tx, { userId: jollof.createdByUserId, kind: "cash", amountKobo: -jollof.hostPoolKobo, type: "party_fund", refType: "party", refId: jollof.id, idempotencyKey: `party_fund:${jollof.id}` });

  // Sealed hosts play, so Tunde holds a seat in his own party; the brands don't.
  const seats = [
    [afro, "kemz"], [afro, "zee"], [afro, "ada.o"],
    [football, "tunde"], [football, "segunola"],
    [jollof, "ada.o"], [jollof, "kemz"],
  ] as const;
  for (const [p, handle] of seats) {
    const key = `party_entry:${p.id}:${by[handle]}`;
    if (p.entryKobo) await topUp(tx, by[handle], p.entryKobo, key);
    await ledger.charge(tx, { userId: by[handle], amountKobo: p.entryKobo, type: "party_entry", refType: "party", refId: p.id, idempotencyKey: key });
    await tx.insert(partyPlayers).values({ partyId: p.id, userId: by[handle] });
  }

  await tx.insert(chatMessages).values([
    ...demoParties.map((p) => ({ partyId: p.id, system: true, text: "Party is open. Your followers have been told." })),
    { partyId: afro.id, userId: by["kemz"], text: "Who's ready? 😤" },
    { partyId: afro.id, userId: by["zee"], sticker: "🔥" },
    { partyId: afro.id, userId: by["ada.o"], text: "@kemz you're going down this time", mentions: ["kemz"] },
    { partyId: football.id, userId: by["tunde"], text: "Pot grows with every seat. Bring your people." },
  ]);
  scheduled.push(...demoParties);

  await tx.insert(appConfig).values({ key: "payout", value: DEFAULT_PAYOUT_CONFIG }).onConflictDoUpdate({ target: appConfig.key, set: { value: DEFAULT_PAYOUT_CONFIG, updatedAt: new Date() } });
  await tx.insert(appConfig).values({ key: "party", value: DEFAULT_PARTY_CONFIG }).onConflictDoUpdate({ target: appConfig.key, set: { value: DEFAULT_PARTY_CONFIG, updatedAt: new Date() } });
  await tx.insert(appConfig).values({ key: "questions", value: DEFAULT_QUESTIONS_CONFIG }).onConflictDoUpdate({ target: appConfig.key, set: { value: DEFAULT_QUESTIONS_CONFIG, updatedAt: new Date() } });
});

// After commit, like the API: the questions service builds each sealed set now, the worker starts each party at startsAt.
const partyJobs = partyQueue();
const questionJobs = questionsQueue();
for (const p of scheduled) {
  await questionJobs.add("generate_set", { kind: "generate_set", partyId: p.id }, { jobId: `generate-set-${p.id}` });
  await partyJobs.add("start", { kind: "start", partyId: p.id }, { delay: Math.max(0, p.startsAt.getTime() - Date.now()), jobId: `start-${p.id}` });
}
await closeQueues(partyJobs, questionJobs);

console.log(`Seeded ${people.length} users and ${scheduled.length} parties starting in 15, 30 and 60 minutes. Try: curl -H 'x-dev-user: tunde' http://localhost:4000/me`);
await sql.end();
