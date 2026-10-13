import { kobo } from "@contestly/shared";
import { db, sql } from "./client.js";
import { users, follows, parties, partyPlayers, chatMessages } from "./schema.js";
import * as ledger from "./ledger.js";

const people = [
  { handle: "tunde", displayName: "Tunde Bakare", avatarEmoji: "🦁", bio: "Football head. I host a party every Friday night.", interests: ["Football", "General knowledge"] },
  { handle: "ada.o", displayName: "Ada Obi", avatarEmoji: "🦋", bio: "Law student. Trivia is my cardio.", interests: ["Afrobeats", "History"] },
  { handle: "kemz", displayName: "Kemi Adeyemi", avatarEmoji: "🌻", bio: "Nollywood encyclopedia.", interests: ["Nollywood", "Reality TV"] },
  { handle: "segunola", displayName: "Segun Ola", avatarEmoji: "⚡", bio: "Engineer by day, quiz goat by night.", interests: ["Tech", "Maths"] },
  { handle: "zee", displayName: "Zainab Musa", avatarEmoji: "🌙", bio: "Streaks are a lifestyle.", interests: ["Geography", "Fashion"] },
  { handle: "afrobeatsweekly", displayName: "Afrobeats Weekly", avatarEmoji: "🎶", bio: "Official account. The home of Afrobeats.", interests: ["Afrobeats"], isBrand: true, isVerified: true },
  { handle: "jollofrepublic", displayName: "Jollof Republic", avatarEmoji: "🍛", bio: "Free-entry lunch parties every weekday.", interests: ["Food"], isBrand: true, isVerified: true },
];

const rows = await db.insert(users).values(people).onConflictDoNothing().returning();
const all = rows.length ? rows : await db.select().from(users);
const by = Object.fromEntries(all.map((u) => [u.handle, u]));

await db.insert(follows).values([
  { followerId: by["ada.o"].id, followeeId: by["tunde"].id },
  { followerId: by["kemz"].id, followeeId: by["tunde"].id },
  { followerId: by["tunde"].id, followeeId: by["afrobeatsweekly"].id },
  { followerId: by["zee"].id, followeeId: by["afrobeatsweekly"].id },
]).onConflictDoNothing();

await db.transaction(async (tx) => {
  for (const u of all) {
    await ledger.post(tx, { userId: u.id, kind: "bonus", amountKobo: kobo(500), type: "welcome_bonus", idempotencyKey: `seed:welcome:${u.id}` });
    if (u.isBrand) await ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: kobo(200_000), type: "topup", idempotencyKey: `seed:brandcash:${u.id}` });
  }
});

const soon = (m: number) => new Date(Date.now() + m * 60_000);
const [p1, p2, p3] = await db.insert(parties).values([
  { hostId: by["afrobeatsweekly"].id, title: "Afrobeats 2010s throwback", category: "Afrobeats", entryKobo: kobo(200), maxPlayers: 10, funding: "pooled", split: [60, 30, 10], coverColor: "#7B5CFF", coverEmoji: "🎶", startsAt: soon(15) },
  { hostId: by["tunde"].id, title: "Friday night football", category: "Football", entryKobo: kobo(500), maxPlayers: 6, funding: "pooled", split: [70, 30], coverColor: "#0FA97A", coverEmoji: "⚽", startsAt: soon(30) },
  { hostId: by["jollofrepublic"].id, title: "Jollof Republic lunch break", category: "Food", entryKobo: 0, maxPlayers: 50, funding: "host", hostPoolKobo: kobo(20_000), split: [50, 30, 20], coverColor: "#FF8A3D", coverEmoji: "🍛", startsAt: soon(60) },
]).returning();

await db.insert(partyPlayers).values([
  { partyId: p1.id, userId: by["kemz"].id }, { partyId: p1.id, userId: by["zee"].id }, { partyId: p1.id, userId: by["ada.o"].id },
  { partyId: p2.id, userId: by["tunde"].id }, { partyId: p2.id, userId: by["segunola"].id },
  { partyId: p3.id, userId: by["ada.o"].id }, { partyId: p3.id, userId: by["kemz"].id },
]).onConflictDoNothing();

await db.insert(chatMessages).values([
  { partyId: p1.id, userId: by["kemz"].id, text: "Who's ready? 😤" },
  { partyId: p1.id, userId: by["zee"].id, sticker: "🔥" },
  { partyId: p1.id, userId: by["ada.o"].id, text: "@kemz you're going down this time" },
  { partyId: p2.id, userId: by["tunde"].id, text: "Pot grows with every seat. Bring your people." },
]);

console.log(`Seeded ${all.length} users, 3 parties. Try: curl -H 'x-dev-user: tunde' http://localhost:4000/me`);
await sql.end();
