/**
 * Demo data with fixed IDs. Safe to re-run: users and parties are upserted back to their demo state, and the
 * demo parties' seats, chat and the follows between demo users are replaced. Nothing else in the database is touched.
 * Wallets are the exception: the ledger is append-only, so the one-off seed credits are posted once and never reset.
 */
import { and, inArray, sql as dsql } from "drizzle-orm";
import { kobo, DEFAULT_PAYOUT_CONFIG } from "@contestly/shared";
import { db, sql } from "./client.js";
import { users, follows, parties, partyPlayers, chatMessages, appConfig } from "./schema.js";
import * as ledger from "./ledger.js";

const uid = (n: number) => `00000000-0000-4000-8000-1000000000${String(n).padStart(2, "0")}`;
const pid = (n: number) => `00000000-0000-4000-8000-2000000000${String(n).padStart(2, "0")}`;
const cid = (n: number) => `00000000-0000-4000-8000-3000000000${String(n).padStart(2, "0")}`;

const people = [
  { id: uid(1), handle: "tunde", displayName: "Tunde Bakare", avatarEmoji: "🦁", bio: "Football head. I host a party every Friday night.", interests: ["Football", "General knowledge"], isBrand: false, isVerified: false },
  { id: uid(2), handle: "ada.o", displayName: "Ada Obi", avatarEmoji: "🦋", bio: "Law student. Trivia is my cardio.", interests: ["Afrobeats", "History"], isBrand: false, isVerified: false },
  { id: uid(3), handle: "kemz", displayName: "Kemi Adeyemi", avatarEmoji: "🌻", bio: "Nollywood encyclopedia.", interests: ["Nollywood", "Reality TV"], isBrand: false, isVerified: false },
  { id: uid(4), handle: "segunola", displayName: "Segun Ola", avatarEmoji: "⚡", bio: "Engineer by day, quiz goat by night.", interests: ["Tech", "Maths"], isBrand: false, isVerified: false },
  { id: uid(5), handle: "zee", displayName: "Zainab Musa", avatarEmoji: "🌙", bio: "Streaks are a lifestyle.", interests: ["Geography", "Fashion"], isBrand: false, isVerified: false },
  { id: uid(6), handle: "afrobeatsweekly", displayName: "Afrobeats Weekly", avatarEmoji: "🎶", bio: "Official account. The home of Afrobeats.", interests: ["Afrobeats"], isBrand: true, isVerified: true },
  { id: uid(7), handle: "jollofrepublic", displayName: "Jollof Republic", avatarEmoji: "🍛", bio: "Free-entry lunch parties every weekday.", interests: ["Food"], isBrand: true, isVerified: true },
];

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
    await ledger.post(tx, { userId: u.id, kind: "bonus", amountKobo: kobo(500), type: "welcome_bonus", idempotencyKey: `seed:welcome:${u.id}` });
    if (u.isBrand) await ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: kobo(200_000), type: "topup", idempotencyKey: `seed:brandcash:${u.id}` });
  }

  const soon = (m: number) => new Date(Date.now() + m * 60_000);
  const demoParties = [
    { id: pid(1), hostId: by["afrobeatsweekly"], title: "Afrobeats 2010s throwback", category: "Afrobeats", entryKobo: kobo(200), maxPlayers: 10, funding: "pooled" as const, hostPoolKobo: 0, split: [60, 30, 10], visibility: "public" as const, coverColor: "#7B5CFF", coverEmoji: "🎶", status: "open" as const, startsAt: soon(15) },
    { id: pid(2), hostId: by["tunde"], title: "Friday night football", category: "Football", entryKobo: kobo(500), maxPlayers: 6, funding: "pooled" as const, hostPoolKobo: 0, split: [70, 30], visibility: "public" as const, coverColor: "#0FA97A", coverEmoji: "⚽", status: "open" as const, startsAt: soon(30) },
    { id: pid(3), hostId: by["jollofrepublic"], title: "Jollof Republic lunch break", category: "Food", entryKobo: 0, maxPlayers: 50, funding: "host" as const, hostPoolKobo: kobo(20_000), split: [50, 30, 20], visibility: "public" as const, coverColor: "#FF8A3D", coverEmoji: "🍛", status: "open" as const, startsAt: soon(60) },
  ];
  await tx.insert(parties).values(demoParties).onConflictDoUpdate({
    target: parties.id,
    set: { hostId: dsql`excluded.host_id`, title: dsql`excluded.title`, category: dsql`excluded.category`, entryKobo: dsql`excluded.entry_kobo`, maxPlayers: dsql`excluded.max_players`, funding: dsql`excluded.funding`, hostPoolKobo: dsql`excluded.host_pool_kobo`, split: dsql`excluded.split`, visibility: dsql`excluded.visibility`, coverColor: dsql`excluded.cover_color`, coverEmoji: dsql`excluded.cover_emoji`, status: dsql`excluded.status`, startsAt: dsql`excluded.starts_at` },
  });

  const demoPartyIds = demoParties.map((p) => p.id);
  await tx.delete(partyPlayers).where(inArray(partyPlayers.partyId, demoPartyIds));
  await tx.insert(partyPlayers).values([
    { partyId: pid(1), userId: by["kemz"] }, { partyId: pid(1), userId: by["zee"] }, { partyId: pid(1), userId: by["ada.o"] },
    { partyId: pid(2), userId: by["tunde"] }, { partyId: pid(2), userId: by["segunola"] },
    { partyId: pid(3), userId: by["ada.o"] }, { partyId: pid(3), userId: by["kemz"] },
  ]);

  await tx.delete(chatMessages).where(inArray(chatMessages.partyId, demoPartyIds));
  await tx.insert(chatMessages).values([
    { id: cid(1), partyId: pid(1), userId: by["kemz"], text: "Who's ready? 😤" },
    { id: cid(2), partyId: pid(1), userId: by["zee"], sticker: "🔥" },
    { id: cid(3), partyId: pid(1), userId: by["ada.o"], text: "@kemz you're going down this time" },
    { id: cid(4), partyId: pid(2), userId: by["tunde"], text: "Pot grows with every seat. Bring your people." },
  ]);

  await tx.insert(appConfig).values({ key: "payout", value: DEFAULT_PAYOUT_CONFIG }).onConflictDoUpdate({ target: appConfig.key, set: { value: DEFAULT_PAYOUT_CONFIG, updatedAt: new Date() } });
});

console.log(`Seeded ${people.length} users, 3 parties, payout config. Try: curl -H 'x-dev-user: tunde' http://localhost:4000/me`);
await sql.end();
