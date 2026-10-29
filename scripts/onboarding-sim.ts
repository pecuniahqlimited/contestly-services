/**
 * Onboarding and sign-in end to end, against the running stack, the Firebase Auth emulator and Mailpit:
 * an anonymous session → who's playing → About you (the admin's questions) → email code from Mailpit →
 * the same row, now an account, with the lanes and archetype its picks gave; editing About you from Me;
 * an admin saves a new version, an existing user's answers stay as they were and a new sign-up answers
 * the new one; no coins anywhere; the primary email provider fails and the backup delivers; a guest is refused on a staked party;
 * an approved Climb award is paid on sign-up; Google and Apple through the one-time-code exchange (stub
 * provider), a reused, expired or wrong-session code refused; an existing account is signed into, not
 * merged; phone check and contact matching by hash.
 *
 * Needs AUTH_MODE=dev, FIREBASE_AUTH_EMULATOR_HOST and EMAIL_TRANSPORT=mailpit (see .env.example).
 */
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { eq, desc } from "drizzle-orm";
import { climbAwards, db, emailSends, sql, users } from "@contestly/db";
import { makeRedis } from "@contestly/queue";
import { SIGN_UP_REQUIRED, aboutVersionSchema, kobo, phoneHash, type AboutConfig, type AboutVersion } from "@contestly/shared";
import { API, api, failureCount, ok, sleep } from "./sim-lib.js";

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

// ---------------------------------------------------------------- About you

const aboutSet = async (audience: "person" | "brand"): Promise<AboutVersion> =>
  aboutVersionSchema.parse(await (await fetch(`${API}/onboarding/about?audience=${audience}`)).json());
/** As the app does: one screen per question, in order (no timer), then one save with the version it showed. */
const answerAbout = (s: Session, version: number, answers: Record<string, string[]>) =>
  http(s, "PATCH", "/me/onboarding", { about: { version, answers } });
/** An admin saves a set (dev header: any x-dev-user passes requireAdmin in dev mode). */
const saveSet = (audience: "person" | "brand", config: AboutConfig, reason: string) =>
  api("tunde", "PUT", `/admin/onboarding/about/${audience}`, { config, reason }) as Promise<AboutVersion>;

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
const seededSet = (await aboutSet("person")).config;
try {
  console.log("\n==== anonymous first: who's playing, then About you ====");
  // A known set saved as the current version, so the picks below mean what they say; the set that was current is put back at the end.
  const person = await saveSet("person", { questions: [
    { id: "saturday", prompt: "Saturday night. Where are you?", hint: "Pick all that fit", kind: "multi", min: 1, options: [
      { id: "match", emoji: "⚽", label: "At the match", lanes: ["Football"], weights: { competitor: 1 } },
      { id: "afrobeats", emoji: "🎶", label: "Front row, Afrobeats", lanes: ["Afrobeats", "Hip hop"], weights: { fan: 1 } },
      { id: "quiz", emoji: "🧩", label: "Quiz night", lanes: ["Brain teasers", "General knowledge"], weights: { grinder: 1 } },
    ] },
    { id: "rather", prompt: "You'd rather…", hint: "Pick one", kind: "single", options: [
      { id: "beat", emoji: "🏆", label: "Beat my friends", weights: { competitor: 3 } },
      { id: "climb", emoji: "🧗🏾", label: "Climb the leaderboard", weights: { grinder: 3 } },
      { id: "vibe", emoji: "🫶🏾", label: "Just vibe with people", weights: { fan: 3 } },
    ] },
  ] }, `sim:onboarding ${tag}: a known set`);
  ok(person.version > 0 && (await aboutSet("person")).version === person.version, `the admin's save is the current person set (v${person.version})`);
  ok((await aboutSet("brand")).config.questions.length >= 1, "the brand set is there too, for anyone who picks 'a brand'");

  const ada = await anonymous();
  const before = await me(ada);
  ok(before.isGuest === true && before.wallet.bonusKobo === 0 && before.wallet.cashKobo === 0, "a first anonymous session is a guest with no coins");
  ok((await http(ada, "PATCH", "/me/onboarding", { who: "person" })).body.who === "person", "who's playing: just me");
  const partial = await answerAbout(ada, person.version, { saturday: ["quiz"] });
  ok(partial.status === 422 && partial.body.error === "invalid_answers" && partial.body.details[0].questionId === "rather", "every question is answered before the save");
  const wrongOption = await answerAbout(ada, person.version, { saturday: ["quiz"], rather: ["quiz"] });
  ok(wrongOption.status === 422, "an option from another question is refused");
  const picks = await answerAbout(ada, person.version, { saturday: ["quiz", "afrobeats"], rather: ["climb"] });
  ok(picks.status === 200 && picks.body.archetype === "grinder" && picks.body.aboutVersion === person.version, `grinder: 1 + 3 beats fan 1 (${picks.body.archetype})`);
  ok(same(picks.body.lanes, ["Afrobeats", "Hip hop", "Brain teasers", "General knowledge"]), `lanes from every pick, each once (${picks.body.lanes})`);

  console.log("\n==== email code from Mailpit: the guest signs up, same account, picks kept ====");
  const adaEmail = `sim${tag}ada@gmail.com`;
  ok((await http(ada, "POST", "/auth/email/start", { email: adaEmail })).status === 200, "a code is sent");
  const first = await mailFor(adaEmail);
  ok(first.provider === "zeptomail", `the primary provider sent it (${first.provider})`);
  ok((await http(ada, "POST", "/auth/email/start", { email: adaEmail })).body.error === "resend_cooldown", "a new code only after 30 s");
  const wrong = await http(ada, "POST", "/auth/email/verify", { email: adaEmail, code: first.code === "000000" ? "111111" : "000000" });
  ok(wrong.status === 400 && wrong.body.error === "invalid_code", "a wrong code is refused");
  const bayo = await anonymous();
  const bayoTries = await http(bayo, "POST", "/auth/email/verify", { email: adaEmail, code: first.code });
  ok(bayoTries.status === 400, "the right code from another session is refused (codes are bound to who asked)");
  const verified = await http(ada, "POST", "/auth/email/verify", { email: adaEmail, code: first.code });
  ok(verified.body.account === "upgraded" && !("onboardingBonus" in verified.body) && !("bonusKobo" in verified.body), `signed up, and nothing about coins (${JSON.stringify({ ...verified.body, customToken: "…" })})`);
  const adaMember = await withCustomToken(verified.body.customToken);
  ok(adaMember.uid === ada.uid, "the custom token is for the guest's own anonymous uid");
  const adaNow = await me(adaMember);
  ok(adaNow.isGuest === false && adaNow.email === adaEmail && adaNow.id === before.id, "same row, now an account");
  ok(adaNow.wallet.bonusKobo === 0 && adaNow.wallet.cashKobo === 0, "no sign-up bonus (open question 5)");
  ok((await http(ada, "POST", "/auth/email/verify", { email: adaEmail, code: first.code })).body.error === "invalid_code", "a code works once");
  const state = (await http(adaMember, "GET", "/onboarding")).body;
  ok(state.signedUp && state.archetype === "grinder" && state.aboutVersion === person.version && state.lanes.includes("Brain teasers"), "onboarding knows: signed up, About you kept (never asked twice)");

  console.log("\n==== About you from Me, then a new version from the admin ====");
  const mine = (await http(adaMember, "GET", "/me/onboarding")).body;
  ok(mine.answered.version === person.version && mine.current.version === person.version && same(mine.prefill, mine.answered.answers), "Me shows the answers, prefilled against the current set");
  const edited = await answerAbout(adaMember, person.version, { saturday: ["match"], rather: ["beat"] });
  ok(edited.body.archetype === "competitor" && same(edited.body.lanes, ["Football"]), `editing from Me re-derives lanes and archetype (${edited.body.archetype})`);
  await answerAbout(adaMember, person.version, { saturday: ["quiz", "afrobeats"], rather: ["climb"] }); // back to grinder

  // v+1: "quiz" goes, "climb" now weighs fan, and a new question.
  const next = await saveSet("person", { questions: [
    { ...person.config.questions[0], options: person.config.questions[0].options.filter((o) => o.id !== "quiz") },
    { ...person.config.questions[1], options: person.config.questions[1].options.map((o) => (o.id === "climb" ? { ...o, weights: { fan: 3 } } : o)) },
    { id: "when", prompt: "When do you play?", hint: "Pick one", kind: "single", options: [
      { id: "lunch", emoji: "🥪", label: "Lunch break", weights: { grinder: 1 } },
      { id: "late", emoji: "🌙", label: "Late night", weights: { fan: 1 } },
    ] },
  ] }, `sim:onboarding ${tag}: drop quiz, add when`);
  ok(next.version === person.version + 1, `a save is the next version (v${next.version})`);
  const [adaRow] = await db.select().from(users).where(eq(users.id, adaNow.id));
  ok(adaRow.aboutVersion === person.version && adaRow.archetype === "grinder" && same(adaRow.aboutAnswers, { saturday: ["quiz", "afrobeats"], rather: ["climb"] }), "Ada's answers, version and archetype are untouched by the new version");
  const mineNow = (await http(adaMember, "GET", "/me/onboarding")).body;
  ok(mineNow.current.version === next.version && mineNow.hasNewQuestions === true && same(mineNow.prefill, { saturday: ["afrobeats"], rather: ["climb"] }), `Me offers the new set, prefilled where ids still match (${JSON.stringify(mineNow.prefill)})`);
  ok((await answerAbout(adaMember, next.version, mineNow.prefill)).status === 422, "the new question has to be answered to save against the new version");

  const chi = await anonymous();
  const chiSet = await aboutSet("person");
  ok(chiSet.version === next.version, "a new guest gets the new version");
  const chiPicks = await answerAbout(chi, chiSet.version, { saturday: ["match"], rather: ["climb"], when: ["late"] });
  ok(chiPicks.body.archetype === "fan" && chiPicks.body.aboutVersion === next.version, `and the new weights: climb is fan now (${chiPicks.body.archetype})`);
  const chiSignUp = await signUpByEmail(chi, `sim${tag}chi@example.com`);
  ok(chiSignUp.body.account === "upgraded", "Chi signs up");
  const chiState = (await http(await withCustomToken(chiSignUp.body.customToken), "GET", "/onboarding")).body;
  ok(chiState.aboutVersion === next.version && chiState.archetype === "fan", "with the new version's answers and archetype");
  const oldAnswersNewGuest = await answerAbout(await anonymous(), person.version, { saturday: ["quiz"], rather: ["beat"] });
  ok(oldAnswersNewGuest.status === 200 && oldAnswersNewGuest.body.aboutVersion === person.version, "answers against the version a client was shown still save (it was current when they saw it)");

  console.log("\n==== a brand answers the brand set, and is always host ====");
  const brandSet = await aboutSet("brand");
  const dami = await anonymous();
  await http(dami, "PATCH", "/me/onboarding", { who: "brand" });
  const brandAnswers = Object.fromEntries(brandSet.config.questions.map((q) => [q.id, q.options.slice(0, q.kind === "single" ? 1 : (q.min ?? 1)).map((o) => o.id)]));
  const brandPicks = await answerAbout(dami, brandSet.version, brandAnswers);
  ok(brandPicks.body.archetype === "host" && brandPicks.body.who === "brand", `a brand is host (${brandPicks.body.archetype})`);
  ok((await answerAbout(dami, person.version, { saturday: ["match"], rather: ["beat"] })).status === 422, "a brand can't answer the person set");

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
  ok(backOut.body.account === "existing", "an identity that's already an account signs into it");
  const ginaAgain = await withCustomToken(backOut.body.customToken);
  ok(ginaAgain.uid === gina.uid && (await me(ginaAgain)).id === (await me(ginaMember)).id, "the token is for her account's uid; the new phone's guest is left alone");
  ok((await me(ginaNewPhone)).isGuest === true, "and that guest row stays a guest");
  // The same person by email code (the email is the account key) lands on the same account too.
  const byEmail = await signUpByEmail(await anonymous(), ginaEmail);
  ok(byEmail.body.account === "existing" && (await withCustomToken(byEmail.body.customToken)).uid === gina.uid, "her email code signs into the account Google made");

  console.log("\n==== deleting an account: re-verify, delete, gone; the email signs up again as someone new ====");
  const ivy = await anonymous();
  const ivyEmail = `sim${tag}ivy@example.com`;
  const ivyMember = await withCustomToken((await signUpByEmail(ivy, ivyEmail)).body.customToken);
  const ivyId = (await me(ivyMember)).id;
  ok((await http(ivyMember, "DELETE", "/me", {})).body.error === "reverify_required", "deleting needs a fresh sign-in first");
  const rv = await providerRoundTrip(ivyMember, "google", ivyEmail);
  const again = await exchange(ivyMember, rv.deepLink.searchParams.get("code")!, rv.verifier);
  ok(again.body.account === "existing", "signing in again to the same account (Google)…");
  const status = (await http(ivyMember, "GET", "/me/deletion")).body;
  ok(!!status.reverifiedUntil && status.blockers.length === 0, "…opens the 5-minute window, with nothing in the way");
  const gone = await http(ivyMember, "DELETE", "/me", { reason: "not_using" });
  ok(gone.status === 200 && gone.body.deleted === true, "deleted");
  const after = await http(ivyMember, "GET", "/me");
  ok(after.status === 401 && after.body.error === "account_gone", `its session is gone (${after.status} ${after.body.error})`);
  const ivyAgain = await signUpByEmail(await anonymous(), ivyEmail);
  ok(ivyAgain.body.account === "upgraded", "the same email signs up again");
  const ivyNew = await me(await withCustomToken(ivyAgain.body.customToken));
  ok(ivyNew.id !== ivyId && ivyNew.email === ivyEmail, "as a new account, not the deleted one");

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
  await api("tunde", "PUT", "/admin/onboarding/about/person", { config: seededSet, reason: `sim:onboarding ${tag}: put the set back` });
  await redis.quit();
  await sql.end();
}

console.log(failureCount() ? `\n${failureCount()} check(s) failed` : "\nall onboarding checks passed");
process.exit(failureCount() ? 1 : 0);
