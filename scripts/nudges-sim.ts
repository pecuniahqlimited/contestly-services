/**
 * sim:nudges (row 9), against the running stack with the log push provider (PUSH_PROVIDER=log, the default):
 * an admin grants a host a corner; a follower hears about the host's new party; one of the host's people joins
 * and the host hears it; an @mention in the lobby reaches one player as an in-app banner (their inbox room is
 * open) and is held back from another by quiet hours where they are; "starts in 5" reaches that same player in
 * their small hours (a party they're in is exempt) but not the host, who is in the room; and the party going
 * live reaches the seated players who aren't in the room. Reads the nudge records from Postgres, as the other
 * sims read answers.
 */
import { randomUUID } from "node:crypto";
import { Client, type Room } from "colyseus.js";
import { and, eq } from "drizzle-orm";
import { db, nudges, users } from "@contestly/db";
import { partyQueue, closeQueues } from "@contestly/queue";
import { INBOX_ROOM, INSTALL_ID_HEADER, MSG, PARTY_ROOM, localClock, parseThreadLink, type NudgeMessage } from "@contestly/shared";
import { putBack, API, RT, api, failureCount, inMinutes, makeContacts, ok, simHeaders, waitFor } from "./sim-lib.js";

const tag = Date.now().toString(36).slice(-5);
const [HOST, NIGHT, DAYTIME, FRIEND, FAN] = ["host", "night", "day", "friend", "fan"].map((r) => `nudge.${r}.${tag}`);
const ADMIN = process.env.SIM_ADMIN ?? "tunde";

/** A zone where it's now within these local hours (Etc/GMT±N: real IANA zones, one per offset). */
function zoneAt(hours: number[]): string {
  for (let offset = -12; offset <= 14; offset++) {
    const zone = offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
    if (hours.includes(localClock(new Date(), zone).hour)) return zone;
  }
  throw new Error("no zone found");
}
const QUIET_ZONE = zoneAt([1, 2, 3, 4]);
const DAY_ZONE = zoneAt([11, 12, 13, 14, 15]);

/** PUT /me/device, as the app does on launch: this install's token and the zone. */
async function registerDevice(handle: string, timeZone: string) {
  const res = await fetch(`${API}/me/device`, {
    method: "PUT",
    headers: { "x-dev-user": handle, [INSTALL_ID_HEADER]: `sim-install-${handle.replace(/\./g, "-")}-xxxxxxxx`, "content-type": "application/json", ...simHeaders() },
    body: JSON.stringify({ platform: "android", token: `sim-token-${handle}`, appVersion: "0.0.0-sim", permission: "granted", timeZone }),
  });
  if (res.status !== 200) throw new Error(`register ${handle}: ${res.status} ${await res.text()}`);
}

const idOf = async (handle: string) => (await db.select({ id: users.id }).from(users).where(eq(users.handle, handle)))[0].id;
/** The person's nudge of this kind, once the worker has decided it. */
const decided = (handle: string, kind: string, tries = 60) => waitFor(async () => {
  const [n] = await db.select().from(nudges).where(and(eq(nudges.userId, await idOf(handle)), eq(nudges.kind, kind as never)));
  return n && n.status !== "pending" && n.status !== "sending" ? n : null;
}, { tries, everyMs: 1000 });

const rooms: Room[] = [];
const partyJobs = partyQueue();
try {
  console.log(`\nsim:nudges ${tag} (quiet zone ${QUIET_ZONE}, daytime zone ${DAY_ZONE})`);
  for (const h of [HOST, NIGHT, DAYTIME, FRIEND, FAN]) await api(h, "GET", "/me");
  await registerDevice(HOST, DAY_ZONE);
  await registerDevice(NIGHT, QUIET_ZONE);
  await registerDevice(DAYTIME, DAY_ZONE);
  await registerDevice(FAN, DAY_ZONE);
  await db.update(users).set({ timeZone: DAY_ZONE }).where(eq(users.handle, FRIEND));
  // The friend is one of the host's people (a matched contact).
  await makeContacts(HOST, FRIEND);

  console.log("\n1. A granted corner, and a party in it");
  const granted = await api(ADMIN, "POST", "/admin/corners/grant", { userId: await idOf(HOST), reason: `sim:nudges ${tag}` });
  ok(granted.corner.status === "unlocked" && granted.granted?.reason === `sim:nudges ${tag}`, "an admin grants the host a corner, marked granted for admins");
  const opened = await decided(HOST, "corner_open");
  ok(opened?.status === "sent" && opened.channel === "push", "the host gets \"Your corner is open\" as a push (the app isn't open)");
  await api(FAN, "POST", `/corners/${granted.corner.id}/follow`);
  const party = await api(HOST, "POST", "/parties", {
    title: `Nudge sim ${tag}`, brief: "Nigerian general knowledge: cities, food, music", entryKobo: 0, maxPlayers: 8, funding: "pooled", split: "winner",
    startsAt: inMinutes(5.6), questionCount: 3, secondsPerQuestion: 5, visibility: "public",
  });
  const cornerParty = await decided(FAN, "corner_party");
  ok(cornerParty?.status === "sent" && cornerParty.title === `New party in ${granted.corner.name}`, "the corner's follower hears about the new party");

  console.log("\n2. One of your people joined");
  for (const h of [NIGHT, DAYTIME]) await api(h, "POST", `/parties/${party.id}/join`);
  await api(FRIEND, "POST", `/parties/${party.id}/join`);
  const joined = await decided(HOST, "people_joined");
  ok(joined?.status === "sent" && joined.title === `${FRIEND} joined ${party.title}`, "the host hears one of their people joined (and not about the others)");

  console.log("\n3. A mention: a banner for one, quiet hours for another");
  const inbox = await new Client(RT).joinOrCreate(INBOX_ROOM, { userId: await idOf(DAYTIME), devUser: DAYTIME });
  rooms.push(inbox);
  const banner = new Promise<NudgeMessage>((resolve) => inbox.onMessage(MSG.nudge, (m: NudgeMessage) => resolve(m)));
  const lobby = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId: party.id, devUser: HOST });
  rooms.push(lobby);
  lobby.onMessage("*", () => {});
  lobby.send(MSG.chat, { clientMsgId: randomUUID(), text: `Ready @${DAYTIME} and @${NIGHT}?` });
  const shown = await Promise.race([banner, new Promise<null>((r) => setTimeout(() => r(null), 30_000))]);
  ok(shown?.kind === "mention" && shown.title === `${HOST} mentioned you` && parseThreadLink(shown.deepLink)?.kind === "party", "the open app gets the mention as a banner, opening the party's chat");
  const asBanner = await decided(DAYTIME, "mention");
  ok(asBanner?.channel === "banner" && asBanner.pushes === 0, "and it replaced the push");
  const quiet = await decided(NIGHT, "mention");
  ok(quiet?.status === "skipped" && quiet.skipReason === "quiet_hours", "the player in their small hours doesn't get it (quiet hours, logged)");

  console.log("\n4. Starts in 5 (the worker's minute sweep)");
  const t5 = await decided(NIGHT, "party_starting", 150);
  ok(t5?.status === "sent" && t5.channel === "push" && t5.title === `${party.title} starts in 5 minutes`, "\"starts in 5\" reaches the player in their small hours anyway (a party they're in)");
  const hostT5 = await decided(HOST, "party_starting", 10);
  ok(hostT5?.status === "skipped" && hostT5.skipReason === "not_needed", "but not the host, who's already in the room");

  console.log("\n5. Live");
  await waitFor(async () => (await api(HOST, "GET", `/parties/${party.id}`)).questions.status === "ready" || null, { tries: 120, everyMs: 500 });
  await partyJobs.add("start", { kind: "start", partyId: party.id }); // start now, as dev:bots does, rather than wait
  const live = await decided(DAYTIME, "party_live", 90);
  ok(live?.status === "sent" && live.title === `${party.title} is live`, "a seated player who isn't in the room hears it's live");
  const hostLive = await decided(HOST, "party_live", 10);
  ok(!hostLive || hostLive.skipReason === "not_needed", "the host, in the room, doesn't");
} catch (e) {
  ok(false, `sim:nudges stopped: ${(e as Error).message}`);
} finally {
  for (const r of rooms) await r.leave().catch(() => {});
  await closeQueues(partyJobs);
}

const failures = failureCount();
console.log(failures ? `\n✗ nudges sim: ${failures} failure(s)` : "\n✓ nudges sim passed");
// Admin config this sim changed (the AI routing, if it wasn't on the sims' profile) goes back as it was.
await putBack();
process.exit(failures ? 1 : 0);
