/**
 * Row 8 sim (ADR 0017): a brand from first screen to its first goods prize, against the running stack. A person makes
 * a brand (nobody signs in as one); unverified, it hosts free parties only; a team by handle and by email (the invite
 * lands in Mailpit, and in the invitee's account when they sign up); each role's limits; verification (the checklist,
 * the business email code from Mailpit, changes needed and its nudge, approval and its corner); the brand wallet
 * (topped up, funding a cash prize, owner-only withdrawal through the mock provider); a goods party settled by the
 * worker, its prize arranged, disputed and delivered with the nudges; a DM from the brand through the inbox room (the
 * team member kept, never shown); the team locked out of its curate party; and ownership handed over.
 *
 * TEST-ONLY: sets the owner's phone as verified straight in Postgres (SMS is sim:onboarding's), writes ranks to settle
 * a party (as sim:stakes does), backdates a fulfilment to run the worker's delivery sweep now.
 *
 * Run with the stack up (npm run infra:up && npm run dev; PAYMENTS_DEV_TOOLS=true, EMAIL_TRANSPORT=mailpit):  npm run sim:brands
 */
import { randomUUID } from "node:crypto";
import { Client, type Room } from "colyseus.js";
import { and, eq } from "drizzle-orm";
import { brandEvents, chatMessages, corners, db, nudges, parties, partyPlayers, prizeFulfilments, recordDeliveryNudges, sql, users } from "@contestly/db";
import { closeQueues, partyQueue } from "@contestly/queue";
import { INBOX_ROOM, MSG, kobo, type NudgeKind } from "@contestly/shared";
import { putBack, RT, SIM_PNG, api, call, failureCount, latestMail, mailedCode, ok, uploadLogo, waitFor, type ActingAs } from "./sim-lib.js";

const run = Date.now().toString(36).slice(-6);
const OWNER = `sbo_${run}`;
const ADMIN = `sba_${run}`;
const HOST = `sbh_${run}`;
const VIEWER = `sbv_${run}`;
const PLAYERS = [`sbp1_${run}`, `sbp2_${run}`, `sbp3_${run}`];
const STRANGER = `sbs_${run}`;
const LATE = `sbl_${run}`; // invited by email before they're on the app
const APPROVER = "simadmin"; // any dev header passes requireAdmin; never on the brand's team
const BRAND = `brand_${run}`;
const partyJobs = partyQueue();

const idOf = async (h: string) => (await db.select({ id: users.id }).from(users).where(eq(users.handle, h)))[0]?.id;
const as = (person: string): ActingAs => ({ person, brand: BRAND });
const free = (over: Record<string, unknown> = {}) => ({ title: "Brand sim quiz", brief: "Nigerian food: dishes, ingredients and which city claims them", funding: "pooled", entryKobo: 0, maxPlayers: 6, split: "winner", ...over });
const nudgesFor = async (handle: string, kind: NudgeKind) => db.select().from(nudges).where(and(eq(nudges.userId, (await idOf(handle))!), eq(nudges.kind, kind)));

for (const h of [OWNER, ADMIN, HOST, VIEWER, STRANGER, ...PLAYERS]) await api(h, "GET", "/me");

console.log("==== a brand, made by a person ====");
const created = await api(OWNER, "POST", "/brands", { name: `Sim Bakes ${run}`, handle: BRAND, logoEmoji: "🧁", lane: "Food" });
const brandId: string = created.id;
ok(created.role === "owner" && created.verification.status === "draft" && !created.isVerified, "the person who made it owns it; it starts as a draft");
ok((await call(OWNER, "POST", "/brands", { name: "Taken", handle: BRAND })).body.error === "handle_taken", "brand handles are unique (one namespace with people)");
ok((await call(BRAND, "GET", "/me")).body.error === "brand_account_session", "nobody signs in as the brand itself");
ok((await call(as(OWNER), "GET", "/me")).body.error === "not_available_as_brand", "a route that didn't opt in refuses the act-as header");
ok((await call(as(STRANGER), "GET", "/wallet")).body.error === "not_a_member", "someone off the team can't act as it");

console.log("\n==== unverified: free parties only ====");
const limits = await api(as(OWNER), "GET", "/parties/limits");
ok(limits.freeOnly === true && limits.canOfferGoods === false, "the builder hears it's free-only and can't offer goods");
ok((await call(as(OWNER), "POST", "/parties", free({ entryKobo: kobo(200) }))).body.error === "brand_not_verified", "an entry fee is refused until it's verified");
const freeParty = await api(as(OWNER), "POST", "/parties", free());
ok(freeParty.host.id === brandId && freeParty.host.kind === "brand" && freeParty.playerCount === 0, "a free party is the brand's, and its creator isn't seated");

console.log("\n==== the team ====");
for (const [h, role] of [[ADMIN, "admin"], [HOST, "host"], [VIEWER, "viewer"]] as const) {
  const inv = await api(OWNER, "POST", `/brands/${brandId}/invites`, { handle: h, role });
  const waiting = await api(h, "GET", "/me/brands");
  ok(waiting.invites.some((i: any) => i.id === inv.inviteId && i.role === role), `${role}: the invite waits in their profile switcher`);
  await api(h, "POST", `/brand-invites/${inv.inviteId}/accept`);
}
const lateEmail = `${LATE}@dev.contestly.invalid`;
const byEmail = await api(ADMIN, "POST", `/brands/${brandId}/invites`, { email: lateEmail, role: "viewer" });
ok(byEmail.to === "email", "an invite by email to someone not on the app yet");
const invMail = await waitFor(() => latestMail(lateEmail), { tries: 40, everyMs: 250 });
ok(!!invMail && invMail.subject.includes(`Sim Bakes ${run}`), `the invite email reached them (${invMail?.subject})`);
await api(LATE, "GET", "/me"); // they sign up (a dev account, with that email)
const lateBrands = await api(LATE, "GET", "/me/brands");
ok(lateBrands.invites.some((i: any) => i.id === byEmail.inviteId) && lateBrands.brands.length === 0, "signed up: the invite is theirs to answer, not a seat yet");
await api(LATE, "POST", `/brand-invites/${byEmail.inviteId}/decline`);
const team = await api(OWNER, "GET", `/brands/${brandId}/team`);
ok(team.members.map((m: any) => m.role).join(",") === "owner,admin,host,viewer", `the team, owner first (${team.members.map((m: any) => m.role).join(",")})`);
ok((await call(as(VIEWER), "POST", "/parties", free())).body.error === "brand_role_forbidden", "a viewer can't host");
ok((await call(as(HOST), "GET", "/wallet")).body.error === "brand_role_forbidden", "a host can't see the wallet");
ok((await call(HOST, "POST", `/brands/${brandId}/invites`, { handle: STRANGER, role: "viewer" })).body.error === "brand_role_forbidden", "a host can't invite");
ok((await call(as(VIEWER), "GET", "/chats")).status === 200, "a viewer reads the brand's inbox");

console.log("\n==== verification ====");
const incomplete = await call(OWNER, "POST", `/brands/${brandId}/verification/submit`);
ok(incomplete.status === 422 && incomplete.body.error === "checklist_incomplete", "it can't be sent for review with the checklist incomplete");
await api(ADMIN, "PATCH", `/brands/${brandId}`, { registrationNumber: "BN 7654321", logoKey: await uploadLogo({ person: ADMIN, brand: BRAND }), socials: { instagram: `https://instagram.com/${BRAND}` }, cashPrizes: true });
const shownLogo = (await api(OWNER, "GET", `/brands/${brandId}`)).logoUrl as string | null;
ok(!!shownLogo && (await (await fetch(shownLogo)).arrayBuffer()).byteLength === SIM_PNG.length, "the logo goes straight to storage and the brand shows it");
const bizEmail = `hello+${run}@${BRAND.replace(/[^a-z0-9]/g, "")}.example`;
await api(ADMIN, "POST", `/brands/${brandId}/business-email/start`, { email: bizEmail });
const code = await mailedCode(bizEmail);
const afterEmail = await api(ADMIN, "POST", `/brands/${brandId}/business-email/verify`, { email: bizEmail, code });
ok(afterEmail.checklist.businessEmail && afterEmail.checklist.payoutAccount === "missing", "the business email is confirmed by its code; cash prizes still need a payout account");
ok((await call(as(ADMIN), "GET", "/wallet/banks")).body.error === "brand_role_forbidden", "only the owner adds payout accounts");
const banks = await api(as(OWNER), "GET", "/wallet/banks");
const resolved = await api(as(OWNER), "POST", "/wallet/bank-accounts/resolve", { bankCode: banks.banks[0].code, accountNumber: `05${String(Date.now()).slice(-8)}` });
const account = (await api(as(OWNER), "POST", "/wallet/bank-accounts", { resolveToken: resolved.resolveToken, accountName: resolved.accountName })).accounts[0];
ok((await api(OWNER, "GET", `/brands/${brandId}/settings`)).checklist.complete, "with the owner's payout account the checklist is complete");
await api(OWNER, "POST", `/brands/${brandId}/verification/submit`);
const queue = await api(APPROVER, "GET", "/admin/brands?status=in_review&limit=100");
ok(queue.brands.some((b: any) => b.id === brandId), "it's in the admin review queue");
await api(APPROVER, "POST", `/admin/brands/${brandId}/request-changes`, { reason: "Add your website as well, please" });
const sentBack = await api(VIEWER, "GET", `/brands/${brandId}/settings`);
ok(sentBack.verification.status === "changes_needed" && sentBack.verification.note === "Add your website as well, please", "changes needed, with the reviewer's note for the team");
ok((await nudgesFor(OWNER, "verification_update")).some((x) => (x.data as any).outcome === "changes_needed"), "the owner gets the verification update nudge");
await api(ADMIN, "PATCH", `/brands/${brandId}`, { siteUrl: `https://${BRAND.replace(/[^a-z0-9]/g, "")}.example` });
await api(ADMIN, "POST", `/brands/${brandId}/verification/submit`);
const approved = await api(APPROVER, "POST", `/admin/brands/${brandId}/approve`, { reason: "CAC and links check out" });
ok(approved.status === "verified" && !!approved.cornerId, "approved: verified, with a corner");
const [corner] = await db.select().from(corners).where(eq(corners.ownerUserId, brandId));
ok(corner?.status === "unlocked" && corner.unlockConfigVersion === null, "its corner opened on approval, not by the unlock thresholds");
const strangerView = (await api(STRANGER, "GET", `/corners/${corner.id}`)).viewer;
ok(strangerView.can.follow && !strangerView.can.post, "anyone can open the brand's corner and follow it");
const hostView = (await api(as(HOST), "GET", `/corners/${corner.id}`)).viewer;
ok(hostView.isOwner && hostView.brandRole === "host" && hostView.can.post && !hostView.can.manage && !hostView.can.follow, "acting as the brand, a host sees its corner as theirs: post, but no mutes or edits, and no Follow");
ok((await call(as(HOST), "POST", `/corners/${corner.id}/posts`, { text: "Suya and trivia, Friday at 8" })).status === 201, "a host posts on the brand's corner");
ok((await call(as(VIEWER), "POST", `/corners/${corner.id}/posts`, { text: "Me too" })).body.error === "brand_role_forbidden", "a viewer only reads it");
ok((await call(HOST, "POST", `/corners/${corner.id}/follow`)).body.error === "cannot_follow_own_corner", "nobody on the team follows the brand's corner");
ok((await nudgesFor(ADMIN, "verification_update")).some((x) => (x.data as any).outcome === "approved"), "the brand's admins hear it was approved");
const found = await api(STRANGER, "GET", `/users/search?q=${BRAND}`);
ok(found.people.some((p: any) => p.id === brandId && p.isBrand && p.isVerified), "people search shows it, marked as a verified brand");
const detail = await api(APPROVER, "GET", `/admin/brands/${brandId}`);
ok(detail.teamSize === 4 && detail.events.some((e: any) => e.kind === "changes_requested"), "the admin view has its team and history");

console.log("\n==== the brand wallet ====");
await api(as(ADMIN), "POST", "/wallet/dev-topup", { nairaAmount: 20_000 });
const hostOwnBefore = (await api(HOST, "GET", "/wallet")).cashKobo;
const cashBody = free({ funding: "host", hostPoolKobo: kobo(2_000), maxPlayers: 4 });
const overLimit = await call(as(HOST), "POST", "/parties", cashBody);
ok(overLimit.body.error === "brand_role_forbidden" && overLimit.body.details?.limitKobo === 0, "a host can't spend the brand's cash until a limit is set (₦0 by default)");
await api(ADMIN, "PATCH", `/brands/${brandId}`, { hostSpendLimitKobo: kobo(2_000) });
const cashParty = await api(as(HOST), "POST", "/parties", cashBody);
ok((await api(as(ADMIN), "GET", "/wallet")).cashKobo === kobo(18_000), "a host's cash prize is held from the brand's wallet");
ok((await api(HOST, "GET", "/wallet")).cashKobo === hostOwnBefore, "the host's own wallet is untouched");
await api(HOST, "POST", `/parties/${cashParty.id}/cancel`, {});
ok((await api(as(OWNER), "GET", "/wallet")).cashKobo === kobo(20_000), "cancelled: back to the brand");
const withdraw = (h: string) => call(as(h), "POST", "/wallet/withdrawals", { amountKobo: kobo(1_500), bankAccountId: account.id, clientRequestId: randomUUID() });
ok((await withdraw(ADMIN)).body.error === "brand_role_forbidden", "an admin can't withdraw the brand's cash");
const noPhone = await withdraw(OWNER);
ok(noPhone.body.error === "withdraw_not_allowed" && noPhone.body.details?.reason === "owner_cannot_withdraw", "the owner needs a verified phone, as for their own withdrawals");
await db.update(users).set({ phone: `+23490${run.replace(/\D/g, "0").padEnd(8, "0").slice(0, 8)}`, phoneVerifiedAt: new Date() }).where(eq(users.id, (await idOf(OWNER))!));
const out = await withdraw(OWNER);
ok(out.status === 201 && out.body.payout.amountKobo === kobo(1_500), "the owner withdraws the brand's cash");
const settled = await waitFor(async () => {
  const list = await api(as(OWNER), "GET", "/wallet/withdrawals");
  return list.payouts.find((p: any) => p.id === out.body.payout.id && p.status === "succeeded");
}, { tries: 60 });
ok(!!settled, "the mock provider settled it");

console.log("\n==== goods: settled, arranged, disputed, delivered ====");
const goods = await api(as(HOST), "POST", "/parties", free({ funding: "host", prizeKind: "product", places: [{ text: "A dozen cupcakes" }], maxPlayers: 4 }));
ok((await call(VIEWER, "POST", `/parties/${goods.id}/join`)).body.error === "brand_team_member", "nobody on the brand's team takes a seat in its prize party");
for (const p of PLAYERS) await api(p, "POST", `/parties/${goods.id}/join`);
await db.update(parties).set({ status: "live", liveAt: new Date() }).where(eq(parties.id, goods.id));
for (const [i, h] of PLAYERS.entries()) await db.update(partyPlayers).set({ rank: i + 1, score: 100 * (3 - i) }).where(and(eq(partyPlayers.partyId, goods.id), eq(partyPlayers.userId, (await idOf(h))!)));
await partyJobs.add("settle", { kind: "settle", partyId: goods.id }, { jobId: `brands-sim-settle-${goods.id}` });
const [award] = (await waitFor(async () => {
  const rows = await db.select().from(prizeFulfilments).where(eq(prizeFulfilments.partyId, goods.id));
  return rows.length ? rows : null;
}, { tries: 40 })) ?? [];
ok(award?.hostUserId === brandId && award.winnerUserId === (await idOf(PLAYERS[0])), "the worker awarded the prize, owed by the brand");
ok((await call(VIEWER, "POST", `/brands/${brandId}/prizes/${award.id}`, { status: "arranged" })).body.error === "brand_role_forbidden", "a viewer can't move a prize on");
await api(HOST, "POST", `/brands/${brandId}/prizes/${award.id}`, { status: "arranged", note: "Pick-up from Yaba on Saturday" });
ok((await nudgesFor(PLAYERS[0], "prize_ready")).length === 1, "the winner gets prize ready");
ok((await nudgesFor(HOST, "prize_ready")).length >= 1 && (await nudgesFor(VIEWER, "prize_ready")).length === 0, "and the brand's hosts (not its viewers)");
const won = await api(PLAYERS[0], "GET", "/me/prizes");
ok(won.prizes[0]?.status === "arranged" && won.prizes[0]?.note === "Pick-up from Yaba on Saturday", "the winner sees it arranged, with the brand's note");
await api(PLAYERS[0], "POST", `/me/prizes/${award.id}/dispute`, { note: "Nobody was there on Saturday" });
ok((await api(OWNER, "GET", `/brands/${brandId}/prizes`)).prizes.find((x: any) => x.id === award.id)?.status === "disputed", "the brand sees the dispute");
await api(ADMIN, "POST", `/brands/${brandId}/prizes/${award.id}`, { status: "delivered", note: "Delivered to their door" });
ok((await api(PLAYERS[0], "GET", "/me/prizes")).prizes[0]?.status === "delivered", "then delivered");
// The delivery sweep: a prize three days old and not delivered nudges both sides once.
const late = await api(as(HOST), "POST", "/parties", free({ funding: "host", prizeKind: "product", places: [{ text: "A cake" }], maxPlayers: 4 }));
const [overdue] = await db.insert(prizeFulfilments).values({ partyId: late.id, place: 1, winnerUserId: (await idOf(PLAYERS[1]))!, hostUserId: brandId, prizeText: "A cake", awardedAt: new Date(Date.now() - 4 * 86_400_000) }).returning();
await recordDeliveryNudges();
await recordDeliveryNudges();
const due = (await nudgesFor(PLAYERS[1], "prize_delivery_due")).filter((x) => (x.data as any).fulfilmentId === overdue.id);
ok(due.length === 1 && (due[0].data as any).day === 3, "day 3: the winner hears once");
ok((await nudgesFor(OWNER, "prize_delivery_due")).some((x) => (x.data as any).fulfilmentId === overdue.id), "and the brand");

console.log("\n==== messages from the brand ====");
ok((await call(as(HOST), "POST", `/dm/${await idOf(STRANGER)}`)).body.error === "cannot_message", "never cold: someone who never joined its parties can't be messaged");
const dm = await api(as(HOST), "POST", `/dm/${await idOf(PLAYERS[0])}`);
ok(dm.permission === "direct", "someone who joined its party: a direct message");
async function inbox(person: string): Promise<{ room: Room; send: (text: string) => Promise<any> }> {
  const room = await new Client(RT).joinOrCreate(INBOX_ROOM, { userId: brandId, actAs: brandId, devUser: person });
  const waiting = new Map<string, (r: any) => void>();
  room.onMessage(MSG.chatAck, (a: any) => waiting.get(a.clientMsgId)?.(a));
  room.onMessage(MSG.error, (e: any) => e.clientMsgId && waiting.get(e.clientMsgId)?.(e));
  for (const t of [MSG.inbox, MSG.nudge, MSG.chatMessage]) room.onMessage(t, () => {});
  const send = (text: string) => new Promise<any>((resolve) => {
    const clientMsgId = randomUUID();
    waiting.set(clientMsgId, resolve);
    room.send(MSG.chat, { clientMsgId, threadId: dm.threadId, text });
    setTimeout(() => resolve({ error: "no reply" }), 5000);
  });
  return { room, send };
}
const hostInbox = await inbox(HOST);
const sent = await hostInbox.send("Thanks for playing! Your cupcakes are on the way.");
ok(sent.message?.author?.id === brandId, "the line comes from the brand");
const [line] = sent.message ? await db.select().from(chatMessages).where(eq(chatMessages.id, sent.message.id)) : [];
ok(line?.sentByUserId === (await idOf(HOST)), "which team member wrote it is kept for moderation");
const page = await api(PLAYERS[0], "GET", `/chats/${dm.threadId}/messages`);
ok(!JSON.stringify(page).includes((await idOf(HOST))!), "the player never sees who on the team wrote it");
const viewerInbox = await inbox(VIEWER);
ok((await viewerInbox.send("Hello from a viewer")).error === "brand_role_forbidden", "a viewer reads the brand's inbox but can't write");
ok(!!(await new Client(RT).joinOrCreate(INBOX_ROOM, { userId: brandId, actAs: brandId, devUser: STRANGER }).then(() => false, () => true)), "someone off the team can't open its inbox");
await hostInbox.room.leave();
await viewerInbox.room.leave();

console.log("\n==== the team and its curate party ====");
const curate = await api(as(OWNER), "POST", "/parties", free({ mode: "curate", questionCount: 4 }));
for (const h of [OWNER, ADMIN, HOST]) ok((await call(h, "POST", `/parties/${curate.id}/join`)).body.error === "seen_the_questions_cannot_play", `the brand's ${h === OWNER ? "owner" : h === ADMIN ? "admin" : "host"} can't play its curate party`);
ok((await call(VIEWER, "GET", `/parties/${curate.id}/drafts`)).status === 403, "a viewer isn't on the host team: no drafts");
ok((await call(VIEWER, "POST", `/parties/${curate.id}/join`)).status < 300, "so a viewer may play it");

console.log("\n==== handing over ====");
ok((await call(OWNER, "POST", `/brands/${brandId}/leave`)).body.error === "owner_must_hand_over", "the owner can't just leave");
ok((await api(OWNER, "GET", "/me/deletion")).blockers.some((b: any) => b.code === "owns_brand"), "nor delete their account while they own it");
await api(OWNER, "POST", `/brands/${brandId}/owner`, { userId: await idOf(ADMIN) });
const after = await api(ADMIN, "GET", `/brands/${brandId}/team`);
ok(after.members.filter((m: any) => m.role === "owner").map((m: any) => m.handle).join() === ADMIN, "one owner, the new one");
ok(after.members.find((m: any) => m.handle === OWNER)?.role === "admin", "the old owner stays on as an admin");
const kinds = new Set((await db.select({ kind: brandEvents.kind }).from(brandEvents).where(eq(brandEvents.brandId, brandId))).map((e) => e.kind));
ok(["created", "invited", "invite_accepted", "invite_declined", "submitted", "changes_requested", "approved", "handed_over"].every((k) => kinds.has(k as never)), "every step is in the brand's history");

await closeQueues(partyJobs);
await sql.end();
console.log(failureCount() ? `\n${failureCount()} check(s) failed` : "\nbrands-sim: all assertions passed");
// Admin config this sim changed (the AI routing, if it wasn't on the sims' profile) goes back as it was.
await putBack();
process.exit(failureCount() ? 1 : 0);
