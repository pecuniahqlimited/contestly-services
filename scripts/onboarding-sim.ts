/**
 * Onboarding and sign-in end to end, against the running stack, the Firebase Auth emulator and Mailpit:
 * anonymous sessions → picks → the onboarding round (shared and solo) → email code from Mailpit → coins
 * kept on the same account; a Gmail alias gets no second bonus, nor does a second account on the same
 * device; the primary email provider fails and the backup delivers; a guest is refused on a staked party;
 * an approved Climb award is paid on sign-up; Google and Apple through the one-time-code exchange (stub
 * provider), a reused, expired or wrong-session code refused; an existing account is signed into, not
 * merged; phone check and contact matching by hash.
 *
 * Needs AUTH_MODE=dev, FIREBASE_AUTH_EMULATOR_HOST and EMAIL_TRANSPORT=mailpit (see .env.example).
 */
import { createHash, randomBytes } from "node:crypto";
import { Client } from "colyseus.js";
import { eq, desc } from "drizzle-orm";
import { bankQuestions, climbAwards, db, emailSends, getOnboardingConfig, setOnboardingConfig, sql, users } from "@contestly/db";
import { makeRedis } from "@contestly/queue";
import { MSG, ONBOARDING_MSG, onboardingRewardsResponseSchema, ONBOARDING_ROOM, SIGN_UP_REQUIRED, kobo, phoneHash, type OnboardingResult } from "@contestly/shared";
import { API, RT, api, correctAnswer, failureCount, leaks, ok, sleep, wrongAnswer } from "./sim-lib.js";

const EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const PROJECT = process.env.FIREBASE_PROJECT_ID ?? "demo-contestly";
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
if (!EMULATOR || process.env.EMAIL_TRANSPORT !== "mailpit") {
  console.error("sim:onboarding needs FIREBASE_AUTH_EMULATOR_HOST and EMAIL_TRANSPORT=mailpit (see .env.example), and the stack started with them.");
  process.exit(1);
}
const IDT = `http://${EMULATOR}/identitytoolkit.googleapis.com/v1`;
const tag = randomBytes(3).toString("hex");
const redis = makeRedis();

// ---------------------------------------------------------------- Firebase (emulator REST, as the app's SDK would)

async function idt<T = any>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${IDT}/${path}?key=sim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
  return json as T;
}
interface Session { token: string; uid: string }
const anonymous = async (): Promise<Session> => {
  const r = await idt("accounts:signUp", { returnSecureToken: true });
  return { token: r.idToken, uid: r.localId };
};
/** The uid a session token is for (Firebase's signInWithCustomToken doesn't return it; the token says). */
const uidOf = (idToken: string) => JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString()).user_id as string;
const withCustomToken = async (customToken: string): Promise<Session> => {
  const r = await idt("accounts:signInWithCustomToken", { token: customToken, returnSecureToken: true });
  return { token: r.idToken, uid: uidOf(r.idToken) };
};
/** The phone check: SMS sign-in on a secondary app instance (here: a fresh emulator session), never linked. */
async function phoneCheckToken(phone: string): Promise<string> {
  const { sessionInfo } = await idt("accounts:sendVerificationCode", { phoneNumber: phone });
  const codes = await (await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/verificationCodes`)).json() as { verificationCodes: { phoneNumber: string; sessionInfo: string; code: string }[] };
  const code = codes.verificationCodes.find((c) => c.sessionInfo === sessionInfo)!.code;
  return (await idt("accounts:signInWithPhoneNumber", { sessionInfo, code })).idToken;
}

// ---------------------------------------------------------------- the API as a session

async function http<T = any>(s: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method, redirect: "manual",
    headers: { authorization: `Bearer ${s.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

// ---------------------------------------------------------------- Mailpit

async function mail(to: string): Promise<{ code: string; provider: string } | null> {
  const search = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`)).json() as { messages: { ID: string }[] };
  const id = search.messages?.[0]?.ID;
  if (!id) return null;
  const msg = await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json() as { Text: string };
  const headers = await (await fetch(`${MAILPIT}/api/v1/message/${id}/headers`)).json() as Record<string, string[]>;
  return { code: msg.Text.match(/\b(\d{6})\b/)![1], provider: headers["X-Contestly-Provider"]?.[0] ?? "" };
}
async function mailFor(to: string, after?: string) {
  for (let i = 0; i < 40; i++) {
    const m = await mail(to);
    if (m && m.code !== after) return m;
    await sleep(250);
  }
  throw new Error(`no email reached ${to}`);
}
/** Ask for a code and sign in with it. */
async function signUpByEmail(s: Session, email: string) {
  const start = await http(s, "POST", "/auth/email/start", { email });
  if (start.status !== 200) throw new Error(`email start ${start.status} ${JSON.stringify(start.body)}`);
  const { code } = await mailFor(email);
  return http(s, "POST", "/auth/email/verify", { email, code });
}

// ---------------------------------------------------------------- the onboarding round

/** Join (matchmaking), answer every question right or wrong, and resolve with this player's result. */
async function playRound(s: Session, deviceId: string, answerRight: boolean): Promise<{ result: OnboardingResult; lobbyCounts: number[]; leaked: string[] }> {
  const room = await new Client(RT).joinOrCreate(ONBOARDING_ROOM, { token: s.token, deviceId });
  const lobbyCounts: number[] = [];
  const leaked: string[] = [];
  return new Promise((resolve, reject) => {
    room.onMessage(ONBOARDING_MSG.lobby, (m: { players: number }) => lobbyCounts.push(m.players));
    room.onMessage(MSG.question, async (view: any) => {
      leaked.push(...leaks(view));
      const [q] = await db.select().from(bankQuestions).where(eq(bankQuestions.id, view.questionId));
      await sleep(300);
      room.send(MSG.answer, answerRight ? correctAnswer("pick_one", q.payload) : wrongAnswer("pick_one", q.payload));
    });
    for (const t of [MSG.reveal, MSG.standings, MSG.finalStandings]) room.onMessage(t, () => {});
    room.onMessage(MSG.error, (e: any) => reject(new Error(`room error ${JSON.stringify(e)}`)));
    room.onMessage(ONBOARDING_MSG.result, (result: OnboardingResult) => {
      void room.leave();
      resolve({ result, lobbyCounts, leaked });
    });
  });
}

// ---------------------------------------------------------------- Google / Apple through the one-time code

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
/** Start, "sign in" at the stub provider as `email`, and follow the browser back to the app's deep link. */
async function providerRoundTrip(s: Session, provider: "google" | "apple", email: string) {
  const { verifier, challenge } = pkce();
  const start = await http<{ url: string }>(s, "POST", "/auth/oauth/start", { provider, returnTo: "contestly://auth", challenge });
  if (start.status !== 200) throw new Error(`oauth start ${start.status} ${JSON.stringify(start.body)}`);
  const atProvider = await fetch(`${start.body.url}&login_hint=${encodeURIComponent(email)}`, { redirect: "manual" });
  const callback = await fetch(atProvider.headers.get("location")!, { redirect: "manual" });
  const deepLink = new URL(callback.headers.get("location")!);
  return { deepLink, verifier };
}
const exchange = (s: Session, code: string, verifier: string) => http(s, "POST", "/auth/exchange", { code, verifier });
const exchangeKey = (code: string) => `auth:exchange:${createHash("sha256").update(code).digest("hex")}`;

const me = (s: Session) => http(s, "GET", "/me").then((r) => r.body);
const randomPhone = () => `+23480${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

// =================================================================

// Every run comes from localhost: start from fresh rate-limit windows (sign-in codes are capped per IP per hour).
// Only ever against a dev stack: this wipes every rate-limit counter in the Valkey it's pointed at.
if (process.env.AUTH_MODE !== "dev" || process.env.NODE_ENV === "production") {
  console.error("sim:onboarding resets rate limits, so it runs only with AUTH_MODE=dev and NODE_ENV not production.");
  process.exit(1);
}
for (const key of await redis.keys("limit:*")) await redis.del(key);
// Short beats so the sim doesn't wait out the real clock; restored at the end.
const savedConfig = await getOnboardingConfig();
await setOnboardingConfig({ ...savedConfig, waitSeconds: 3, questionSeconds: 5, revealSeconds: 1, standingsSeconds: 1 });

try {
  console.log("\n==== anonymous first: picks, then a shared round and a solo one ====");
  const rewards = await (await fetch(`${API}/onboarding/rewards`)).json();
  ok(onboardingRewardsResponseSchema.safeParse(rewards).success && rewards.soloTiers[0].coinsKobo === kobo(500), "the round's rewards are public, for the Bag coins screen");
  const [ada, bayo, chi, dami] = await Promise.all([anonymous(), anonymous(), anonymous(), anonymous()]);
  const adaDevice = `device-ada-${tag}`;
  const before = await me(ada);
  ok(before.isGuest === true && before.wallet.bonusKobo === 0, "a first anonymous session is a guest with no coins");
  const picks = await http(ada, "PATCH", "/me/onboarding", { who: "person", lanes: ["Geography"], why: "grinder" });
  ok(picks.body.archetype === "grinder" && picks.body.picks.lanes[0] === "Geography", "picks saved; the archetype comes back for Home");
  const misfit = await http(ada, "PATCH", "/me/onboarding", { why: "launch" });
  ok(misfit.status === 422, "a brand's 'why' doesn't fit a person");
  ok((await http(ada, "GET", "/onboarding")).body.round === null, "no round yet, so the app still offers it");

  // Ada and Bayo onboard at the same moment: one shared room. Then Chi and Dami alone, each after the last room locked.
  const shared = Promise.all([playRound(ada, adaDevice, true), playRound(bayo, `device-bayo-${tag}`, false)]);
  await sleep(3500);
  const chiRound = playRound(chi, `device-chi-${tag}`, true);
  await sleep(3500);
  const damiRound = playRound(dami, adaDevice, true); // same phone as Ada
  const [[a, b], c, d] = await Promise.all([shared, chiRound, damiRound]);
  ok(a.result.mode === "shared" && a.result.players === 2 && b.result.players === 2, "two people onboarding at once share a round");
  ok(a.lobbyCounts.every((n) => n <= 2) && a.lobbyCounts.includes(2), `the lobby counts only real players (${a.lobbyCounts})`);
  ok(a.result.rank === 1 && b.result.rank === 2 && a.result.coinsKobo === kobo(500) && b.result.coinsKobo === kobo(400), "shared: paid by rank, and everyone gets something");
  ok(c.result.mode === "solo" && c.result.players === 1 && c.result.correct === 3 && c.result.coinsKobo > 0, `alone, a solo round paid by points (${c.result.points} pts → ${c.result.coinsKobo})`);
  ok([...a.leaked, ...c.leaked].length === 0, "no correct answer is sent while a question is open");
  ok((await me(ada)).wallet.bonusKobo === 0, "a guest's coins wait on the round, not in the wallet");
  const again = await new Client(RT).joinOrCreate(ONBOARDING_ROOM, { token: ada.token }).then(() => "joined", (e: Error) => e.message);
  ok(again.includes("already_played"), `one round per account (${again})`);

  console.log("\n==== email code from Mailpit: the guest signs up, same account, coins kept ====");
  const adaEmail = `sim${tag}ada@gmail.com`;
  ok((await http(ada, "POST", "/auth/email/start", { email: adaEmail })).status === 200, "a code is sent");
  const first = await mailFor(adaEmail);
  ok(first.provider === "zeptomail", `the primary provider sent it (${first.provider})`);
  ok((await http(ada, "POST", "/auth/email/start", { email: adaEmail })).body.error === "resend_cooldown", "a new code only after 30 s");
  const wrong = await http(ada, "POST", "/auth/email/verify", { email: adaEmail, code: first.code === "000000" ? "111111" : "000000" });
  ok(wrong.status === 400 && wrong.body.error === "invalid_code", "a wrong code is refused");
  const bayoTries = await http(bayo, "POST", "/auth/email/verify", { email: adaEmail, code: first.code });
  ok(bayoTries.status === 400, "the right code from another session is refused (codes are bound to who asked)");
  const verified = await http(ada, "POST", "/auth/email/verify", { email: adaEmail, code: first.code });
  ok(verified.body.account === "upgraded" && verified.body.onboardingBonus === "granted" && verified.body.bonusKobo === kobo(500), `signed up, coins granted (${JSON.stringify({ ...verified.body, customToken: "…" })})`);
  const adaMember = await withCustomToken(verified.body.customToken);
  ok(adaMember.uid === ada.uid, "the custom token is for the guest's own anonymous uid");
  const adaNow = await me(adaMember);
  ok(adaNow.isGuest === false && adaNow.email === adaEmail && adaNow.wallet.bonusKobo === kobo(500) && adaNow.id === before.id, "same row, now an account with its 500 coins");
  ok((await http(ada, "POST", "/auth/email/verify", { email: adaEmail, code: first.code })).body.error === "invalid_code", "a code works once");
  const state = (await http(adaMember, "GET", "/onboarding")).body;
  ok(state.signedUp && state.round.claimed && state.picks.why === "grinder", "onboarding knows: signed up, coins claimed, picks kept (never asked twice)");

  console.log("\n==== no farming: a Gmail alias, and a second account on the same device ====");
  const alias = `s.i.m${tag}a.d.a+again@googlemail.com`;
  const chiSignUp = await signUpByEmail(chi, alias);
  ok(chiSignUp.body.account === "upgraded" && chiSignUp.body.onboardingBonus === "already_claimed" && chiSignUp.body.bonusKobo === 0, `an alias of the same Gmail signs up but gets no second bonus (${chiSignUp.body.onboardingBonus})`);
  ok((await me(chi)).wallet.bonusKobo === 0, "and nothing landed in its wallet");
  const damiSignUp = await signUpByEmail(dami, `sim${tag}dami@example.com`);
  ok(damiSignUp.body.onboardingBonus === "device_claimed" && damiSignUp.body.bonusKobo === 0, `a new email on a device that already claimed: no bonus (${damiSignUp.body.onboardingBonus})`);

  console.log("\n==== the primary provider fails, the backup delivers ====");
  await redis.set(`dev:email:fail:zeptomail`, "1", "EX", 60);
  const eve = await anonymous();
  const eveEmail = `sim${tag}eve@example.com`;
  ok((await http(eve, "POST", "/auth/email/start", { email: eveEmail })).status === 200, "the code still goes out");
  ok((await mailFor(eveEmail)).provider === "brevo", "Brevo delivered it");
  const [log] = await db.select().from(emailSends).where(eq(emailSends.to, eveEmail)).orderBy(desc(emailSends.createdAt)).limit(1);
  ok(log.deliveredBy === "brevo" && log.attempts[0].provider === "zeptomail" && !log.attempts[0].ok, `the send log says who failed and who delivered (${JSON.stringify(log.attempts)})`);
  await redis.del(`dev:email:fail:zeptomail`);

  console.log("\n==== guests: free parties yes, staked parties and money no ====");
  const base = { brief: "Nigerian geography, easy", startsAt: new Date(Date.now() + 30 * 60_000).toISOString(), questionCount: 3, secondsPerQuestion: 5 };
  const staked = await api("tunde", "POST", "/parties", { ...base, title: `Onboarding sim staked ${tag}`, funding: "pooled", entryKobo: kobo(100), maxPlayers: 6, split: "winner" });
  const free = await api("tunde", "POST", "/parties", { ...base, title: `Onboarding sim free ${tag}`, funding: "pooled", entryKobo: 0, maxPlayers: 6, split: "winner" });
  const guest = await anonymous();
  const stakedJoin = await http(guest, "POST", `/parties/${staked.id}/join`);
  ok(stakedJoin.status === 403 && stakedJoin.body.error === SIGN_UP_REQUIRED, `a guest is refused on a staked party (${stakedJoin.status} ${stakedJoin.body.error})`);
  ok((await http(guest, "POST", `/parties/${free.id}/join`)).status === 201, "a guest joins a free party (entry 0, bragging rights)");
  ok((await http(guest, "POST", "/me/guest", { displayName: "Funmi" })).body.displayName === "Funmi", "a guest plays under a name");
  const hosting = await http(guest, "POST", "/parties", { ...base, title: "guest host", funding: "pooled", entryKobo: kobo(100), maxPlayers: 4, split: "winner" });
  ok(hosting.status === 403 && hosting.body.error === SIGN_UP_REQUIRED, "a guest can't host");
  ok((await http(guest, "GET", "/wallet")).body.error === SIGN_UP_REQUIRED, "a guest has no wallet");
  ok((await fetch(`${API}/users/${(await me(guest)).handle}`)).status === 404, "a guest has no public profile");
  await http(guest, "PUT", "/onboarding/invite", { partyId: staked.id });
  const resume = (await http(guest, "GET", "/onboarding")).body;
  ok(resume.next === "lobby" && resume.invite.partyId === staked.id && resume.invite.staked && resume.invite.canAfford === false, "a staked invite is remembered: onboarding ends in its lobby, and it knows the coins don't cover it yet");

  console.log("\n==== a held Climb award is paid the moment its winner signs up ====");
  const fola = await anonymous();
  const folaId = (await me(fola)).id;
  const adminId = (await api("tunde", "GET", "/me")).id;
  const [award] = await db.insert(climbAwards).values({ week: "2001-01-01", scope: `sim-${tag}`, place: 1, userId: folaId, points: 300, amountKobo: kobo(2_000), status: "approved", decidedByUserId: adminId, decidedAt: new Date() }).returning();
  const folaUp = await signUpByEmail(fola, `sim${tag}fola@example.com`);
  ok(folaUp.body.account === "upgraded", "Fola signs up");
  const [paid] = await db.select().from(climbAwards).where(eq(climbAwards.id, award.id));
  ok(paid.status === "paid" && (await me(fola)).wallet.cashKobo === kobo(2_000), "the approved award was paid to cash at sign-up");

  console.log("\n==== Google and Apple: system browser → deep link → one-time code ====");
  const gina = await anonymous();
  const ginaEmail = `sim${tag}gina@gmail.com`;
  const g = await providerRoundTrip(gina, "google", ginaEmail);
  const gCode = g.deepLink.searchParams.get("code")!;
  ok(g.deepLink.protocol === "contestly:" && !!gCode, `the browser comes back to the app with a code (${g.deepLink.protocol}//${g.deepLink.host})`);
  ok((await exchange(gina, gCode, pkce().verifier)).body.error === "invalid_verifier", "a code with the wrong PKCE verifier is refused (and spent)");
  const g2 = await providerRoundTrip(gina, "google", ginaEmail);
  const gOut = await exchange(gina, g2.deepLink.searchParams.get("code")!, g2.verifier);
  ok(gOut.body.account === "upgraded" && !!gOut.body.customToken, "Google: the guest signs up");
  const ginaMember = await withCustomToken(gOut.body.customToken);
  ok(ginaMember.uid === gina.uid && (await me(ginaMember)).email === ginaEmail, "same uid, same account, verified email from Google");
  ok((await exchange(gina, g2.deepLink.searchParams.get("code")!, g2.verifier)).body.error === "invalid_or_expired_code", "a reused code is refused");

  const hal = await anonymous();
  const h = await providerRoundTrip(hal, "apple", `sim${tag}hal@privaterelay.appleid.com`);
  const hCode = h.deepLink.searchParams.get("code")!;
  await redis.pexpire(exchangeKey(hCode), 1);
  await sleep(20);
  ok((await exchange(hal, hCode, h.verifier)).body.error === "invalid_or_expired_code", "an expired code is refused");
  const h2 = await providerRoundTrip(hal, "apple", `sim${tag}hal@privaterelay.appleid.com`);
  const stranger = await anonymous();
  ok((await exchange(stranger, h2.deepLink.searchParams.get("code")!, h2.verifier)).body.error === "wrong_session", "a code taken to another session is refused");
  const h3 = await providerRoundTrip(hal, "apple", `sim${tag}hal@privaterelay.appleid.com`);
  ok((await exchange(hal, h3.deepLink.searchParams.get("code")!, h3.verifier)).body.account === "upgraded", "Apple: the guest signs up");

  // Gina, on a new phone (a new anonymous session), signs in with Google again: her account, not a merge.
  const ginaNewPhone = await anonymous();
  const back = await providerRoundTrip(ginaNewPhone, "google", ginaEmail);
  const backOut = await exchange(ginaNewPhone, back.deepLink.searchParams.get("code")!, back.verifier);
  ok(backOut.body.account === "existing" && backOut.body.onboardingBonus === "none", "an identity that's already an account signs into it");
  const ginaAgain = await withCustomToken(backOut.body.customToken);
  ok(ginaAgain.uid === gina.uid && (await me(ginaAgain)).id === (await me(ginaMember)).id, "the token is for her account's uid; the new phone's guest is left alone");
  ok((await me(ginaNewPhone)).isGuest === true, "and that guest row stays a guest");
  // The same person by email code (the email is the account key) lands on the same account too.
  const byEmail = await signUpByEmail(await anonymous(), ginaEmail);
  ok(byEmail.body.account === "existing" && (await withCustomToken(byEmail.body.customToken)).uid === gina.uid, "her email code signs into the account Google made");

  console.log("\n==== phone: verified, not linked; contacts matched by hash ====");
  const adaPhone = randomPhone();
  const added = await http(adaMember, "POST", "/me/phone", { idToken: await phoneCheckToken(adaPhone) });
  ok(added.body.phoneAdded === true && (await me(adaMember)).phoneAdded === true, "Ada adds her number");
  const [stored] = await db.select({ phone: users.phone, hmac: users.phoneHmac }).from(users).where(eq(users.email, adaEmail));
  ok(stored.phone === adaPhone && !!stored.hmac && stored.hmac !== (await phoneHash(adaPhone)), "stored as E.164 plus an HMAC (not the bare hash)");
  ok((await http(ginaMember, "POST", "/me/phone", { idToken: await phoneCheckToken(adaPhone) })).body.error === "phone_in_use", "one account per number");
  const match = await http(ginaMember, "POST", "/me/contacts/match", { hashes: [await phoneHash(adaPhone), await phoneHash(randomPhone())] });
  ok(match.body.matches?.length === 1 && match.body.matches[0].handle === adaNow.handle, "Gina's contacts find Ada by hash, and only Ada");
  const none = await http(ginaMember, "POST", "/me/contacts/match", { hashes: [await phoneHash(randomPhone())] });
  ok(none.status === 200 && none.body.matches.length === 0, "nobody matching is an honest empty list");
  ok((await http(ginaMember, "POST", "/me/contacts/match", { hashes: [await phoneHash(randomPhone())] })).body.error === "contacts_limit", "two syncs a day");
  ok((await http(guest, "POST", "/me/contacts/match", { hashes: [await phoneHash(adaPhone)] })).body.error === SIGN_UP_REQUIRED, "guests can't look up contacts");
} finally {
  await setOnboardingConfig(savedConfig);
  await redis.quit();
  await sql.end();
}

console.log(failureCount() ? `\n${failureCount()} check(s) failed` : "\nall onboarding checks passed");
process.exit(failureCount() ? 1 : 0);
