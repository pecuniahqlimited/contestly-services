/**
 * TEST-ONLY helpers shared by the party sims: an API client with the dev identity header, an
 * assertion tally, and answer builders that read the server payload straight from Postgres.
 * Nothing like this exists in the product.
 */
import { and, eq, sql } from "drizzle-orm";
import { climbRounds, contactMatches, db, ledgerAccounts, ledgerEntries, parties, users } from "@contestly/db";
import type { QuestionFormat } from "@contestly/game";
import { DEV_SIM_HEADER } from "@contestly/auth";
import { ACT_AS_HEADER, AI_PROFILES, SOURCE_FILE_FIELD, type AdminAiRouting, type AiProfile, type ClimbGameType } from "@contestly/shared";

export const API = process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
export const RT = process.env.RT_URL ?? `ws://localhost:${process.env.REALTIME_PORT ?? 4001}`;

let failures = 0;
export const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? "✓" : "✗ FAIL"} ${label}`);
  if (!cond) failures++;
};
export const failureCount = () => failures;

/**
 * Admin config a sim changed, put back as it found it. Register each put-back right before the change; the
 * sim calls putBack() in a finally, so a failing sim restores too, and Ctrl-C or a kill runs them as well.
 * Each runs once, newest first; one that fails is logged and counts as a failure, and the rest still run.
 */
const putBacks: { what: string; run: () => Promise<unknown> }[] = [];
let exitHooked = false;
export function putBackLater(what: string, run: () => Promise<unknown>) {
  putBacks.push({ what, run });
  if (exitHooked) return;
  exitHooked = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(`\n(${signal}: putting the admin config back first)`);
      void putBack().finally(() => process.exit(130));
    });
  }
}
export async function putBack() {
  while (putBacks.length) {
    const { what, run } = putBacks.pop()!;
    try {
      await run();
      console.log(`(put back: ${what})`);
    } catch (e) {
      ok(false, `couldn't put back ${what}: ${(e as Error).message}`);
    }
  }
}

/**
 * The AI profile the sims run on (ADR 0016), set through the stack's own API like the console does (the routing:
 * the default and every prize tier), never through the env, and put back afterwards. Mock unless SIM_AI_PROFILE
 * names another (free runs the real free-tier models, and the sims then also check what only a model catches);
 * paid only with SIM_ALLOW_PAID=1. A stack whose ceiling (AI_ALLOWED_PROFILES) refuses it stops the sim.
 */
async function routeAiForSims(): Promise<AiProfile> {
  const want = (process.env.SIM_AI_PROFILE?.trim() || "mock") as AiProfile;
  if (!AI_PROFILES.includes(want)) {
    console.error(`SIM_AI_PROFILE=${want} is not a profile (have: ${AI_PROFILES.join(", ")})`);
    process.exit(2);
  }
  // The sims never spend money by accident.
  if (want === "paid" && process.env.SIM_ALLOW_PAID !== "1") {
    console.error("SIM_AI_PROFILE=paid would spend money. Set SIM_ALLOW_PAID=1 to mean it.");
    process.exit(2);
  }
  const admin = (process.env.DEV_ADMIN_HANDLES ?? "tunde").split(",")[0].trim();
  const headers = { "x-dev-user": admin, "content-type": "application/json" };
  const res = await fetch(`${API}/admin/ai/routing`, { headers }).catch(() => null);
  if (!res?.ok) {
    console.error(`Couldn't read the stack's AI routing (GET /admin/ai/routing as ${admin}: ${res?.status ?? "no answer"}). Is the API running?`);
    process.exit(2);
  }
  const current = (await res.json()) as AdminAiRouting;
  const config = { ...current.config, defaultProfile: want, tiers: current.config.tiers.map((t) => ({ ...t, profile: want })) };
  if (JSON.stringify(config) === JSON.stringify(current.config)) return want;
  const put = (body: unknown) => fetch(`${API}/admin/ai/routing`, { method: "PUT", headers, body: JSON.stringify(body) });
  const set = await put({ config, reason: `the sims run on the ${want} profile` });
  if (!set.ok) {
    console.error(`The stack refused routing the sims to ${want} (${set.status}: ${await set.text()}).`);
    process.exit(2);
  }
  putBackLater("the AI routing", async () => {
    const back = await put({ config: current.config, reason: "the sims put the AI routing back as they found it" });
    if (!back.ok) throw new Error(`PUT /admin/ai/routing: ${back.status}`);
  });
  return want;
}
export const AI_PROFILE = await routeAiForSims();
export const MOCK_GENERATOR = AI_PROFILE === "mock";
/** waitFor tries (every 500 ms) for a question set to be made: real providers take minutes, the mocks a moment. */
export const GENERATION_TRIES = MOCK_GENERATOR ? 120 : 720;
/** A real model safety check (any profile but mock): the sims then also check what only a model would catch. */
export const MODEL_SAFETY = AI_PROFILE !== "mock";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A party's startsAt, this many minutes from now. */
export const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/** Poll until `probe` returns a truthy value, or give up and return null. */
export async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, { tries = 60, everyMs = 500 } = {}): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const v = await probe();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}

/**
 * A party settled and the worker's record_progress job after it has run (who played whom, corner progress):
 * what anything reading "your people" or a host's progress right after a party needs to wait for.
 */
export function waitForProgress(partyId: string) {
  return waitFor(async () => {
    const [p] = await db.select({ status: parties.status, at: parties.progressRecordedAt }).from(parties).where(eq(parties.id, partyId));
    return p?.status === "finished" && !!p.at;
  }, { tries: 60, everyMs: 500 });
}

/**
 * Every request a sim sends marks its account as sim data (DEV_SIM_HEADER), so the parties and corners it makes
 * stay out of real people's suggestions. dev:bots calls leaveUnmarked(): its bots play with real dev accounts.
 */
let marksSim = true;
export const leaveUnmarked = () => void (marksSim = false);
export const simHeaders = (): Record<string, string> => (marksSim ? { [DEV_SIM_HEADER]: "1" } : {});

/** A person acting as a brand (ADR 0017): nobody signs in as a brand, so `person` sends the x-act-as header for it. */
export type ActingAs = { person: string; brand: string };
/** Who a call is from: a dev user's handle, or a person acting as a brand (by the brand's handle). */
export type Caller = string | ActingAs;
const brandIds = new Map<string, string>();
async function brandIdOf(handle: string): Promise<string> {
  if (!brandIds.has(handle)) {
    const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.handle, handle), eq(users.isBrand, true)));
    if (!u) throw new Error(`no brand with handle ${handle}`);
    brandIds.set(handle, u.id);
  }
  return brandIds.get(handle)!;
}
async function callerHeaders(who: Caller): Promise<Record<string, string>> {
  if (typeof who === "string") return { "x-dev-user": who };
  return { "x-dev-user": who.person, [ACT_AS_HEADER]: await brandIdOf(who.brand) };
}

/** Calls the API as a dev user (or a person acting as a brand). Returns { status, body } so callers can assert on refusals too. */
export async function call<T = any>(handle: Caller, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(await callerHeaders(handle)), ...simHeaders(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = res.status === 204 ? ({} as T) : ((await res.json().catch(() => ({}))) as T);
  return { status: res.status, body: json };
}

/** Sends a party's source file as multipart, as the app does. Returns { status, body }. */
export async function sendFile<T = any>(handle: string, partyId: string, file: { filename: string; contentType: string; bytes: Uint8Array<ArrayBuffer> }): Promise<{ status: number; body: T }> {
  const form = new FormData();
  form.append(SOURCE_FILE_FIELD, new Blob([file.bytes], { type: file.contentType }), file.filename);
  const res = await fetch(`${API}/parties/${partyId}/files`, { method: "PUT", headers: { "x-dev-user": handle, ...simHeaders() }, body: form });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

/** Like call(), but throws on any non-2xx (except 402, which the sims assert on). */
export async function api<T = any>(handle: Caller, method: string, path: string, body?: unknown): Promise<T> {
  const { status, body: json } = await call<T>(handle, method, path, body);
  if (status >= 300 && status !== 402) throw new Error(`${method} ${path} → ${status}: ${JSON.stringify(json)}`);
  return json;
}

export const walletTotal = async (handle: string) => {
  const w = (await api(handle, "GET", "/me")).wallet as { cashKobo: number; bonusKobo: number };
  return w.cashKobo + w.bonusKobo;
};

/**
 * Net money a party moved for one user (entries, refunds, prizes; cash and bonus together), read
 * from the ledger by reference. Unlike a wallet before/after, it can't be thrown off by some other
 * party settling or refunding at the same moment.
 */
export async function partyNetKobo(userId: string, partyId: string): Promise<number> {
  const [row] = await db
    .select({ net: sql<number>`coalesce(sum(${ledgerEntries.amountKobo}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(and(eq(ledgerAccounts.userId, userId), eq(ledgerEntries.refType, "party"), eq(ledgerEntries.refId, partyId)));
  return Number(row?.net ?? 0);
}

/** The right answer for each format, straight from the server payload (test-only). */
export function correctAnswer(format: QuestionFormat, payload: any): unknown {
  switch (format) {
    case "pick_one":
    case "picture": return { index: payload.correctIndex };
    case "pick_all": return { indexes: payload.correctIndexes };
    case "order": return { order: payload.correctOrder };
    case "match": return { pairs: payload.pairs };
  }
}

/** A deliberately wrong answer. */
export function wrongAnswer(format: QuestionFormat, payload: any): unknown {
  switch (format) {
    case "pick_one":
    case "picture": return { index: (payload.correctIndex + 1) % payload.options.length };
    case "pick_all": return { indexes: [payload.correctIndexes[0] === 0 ? 1 : 0].filter((i) => !payload.correctIndexes.includes(i)) };
    case "order": return { order: [...payload.correctOrder].reverse() };
    case "match": return { pairs: payload.pairs.map((p: number) => (p + 1) % payload.right.length) };
  }
}

/** Deep-scan a payload for anything that looks like a leaked correct answer. */
export function leaks(view: unknown): string[] {
  const banned = ["correctIndex", "correctIndexes", "correctOrder", "pairs"];
  const found: string[] = [];
  const walk = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (banned.includes(k)) found.push(k);
      walk(v);
    }
  };
  walk(view);
  return found;
}

// ---- The Climb (test-only: the "perfect player" reads round answers from Postgres) ----

/** Wait until the server opens the next round, then fetch it. */
export async function nextClimbRound(handle: string, state: any) {
  while (!state.round && state.run.status === "active") {
    await sleep(Math.max(0, Date.parse(state.nextOpensAt) - Date.now()) + 50);
    state = await api(handle, "GET", `/climb/runs/${state.run.id}`);
  }
  return state;
}

/** The answer a perfect player gives, from the stored round (test-only). */
export async function rightClimbAnswer(roundId: string) {
  const [r] = await db.select().from(climbRounds).where(eq(climbRounds.id, roundId));
  const p = r.payload as any;
  const byType: Record<ClimbGameType, () => unknown> = {
    pattern: () => ({ index: p.correctIndex }),
    scramble: () => ({ word: p.word }),
    word_hunt: () => ({ words: p.placed }),
    quick_maths: () => ({ value: p.value }),
    memory: () => ({ sequence: p.sequence }),
    pattern_recall: () => ({ sequence: p.sequence }),
    word_search: () => ({ found: p.placements }),
  };
  return byType[r.gameType as ClimbGameType]();
}
export const wrongClimbAnswer = { index: -1, word: "zzzz", words: [], value: -999999, sequence: [], found: [] };


/**
 * TEST-ONLY: `a` has `b`'s number in their contacts, as POST /me/contacts/match would record after both added a
 * phone (which needs a real SMS). Contacts are your people and can message each other directly (ADR 0012).
 */
export async function makeContacts(aHandle: string, bHandle: string) {
  const id = async (h: string) => (await db.select({ id: users.id }).from(users).where(eq(users.handle, h)))[0].id;
  await db.insert(contactMatches).values({ userId: await id(aHandle), contactUserId: await id(bHandle) }).onConflictDoNothing();
}

// ---- mail and brands (Mailpit; ADR 0017) ------------------------------------------------

export const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
/** The newest mail to `to` in Mailpit: its text, or null. */
export async function latestMail(to: string): Promise<{ id: string; text: string; subject: string } | null> {
  const search = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`)).json() as { messages?: { ID: string; Subject: string }[] };
  const m = search.messages?.[0];
  if (!m) return null;
  const msg = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json() as { Text: string };
  return { id: m.ID, text: msg.Text, subject: m.Subject };
}
/** The 6-digit code in the newest mail to `to` (waiting for it to land). */
export async function mailedCode(to: string): Promise<string> {
  const mail = await waitFor(async () => latestMail(to), { tries: 40, everyMs: 250 });
  const code = mail?.text.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`no code mailed to ${to}`);
  return code;
}

/**
 * Send a challenge (ADR 0019) the way the app does: the preset for these people, then POST /parties with it and
 * `challenge`. `party` and `challenge` change the preset's party body and its expiry, window and message.
 */
export async function sendChallenge(from: string, inviteeIds: string[], opts: { party?: Record<string, unknown>; challenge?: Record<string, unknown> } = {}) {
  const preset = await call(from, "GET", `/challenges/preset?userIds=${inviteeIds.join(",")}`);
  if (preset.status !== 200) return preset;
  return call(from, "POST", "/parties", {
    ...preset.body.party, questionCount: 3, secondsPerQuestion: 5, ...opts.party,
    challenge: { invitees: inviteeIds, ...preset.body.challenge, ...opts.challenge },
  });
}

/** The PNG signature and a few bytes: what a logo upload's attach check reads. */
export const SIM_PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(56).fill(7)]);

/** A logo uploaded as the app does it: an upload URL acting as the brand, the bytes PUT straight to storage. Returns the key. */
export async function uploadLogo(as: ActingAs, bytes: Uint8Array = SIM_PNG): Promise<string> {
  const { key, upload } = await api<{ key: string; upload: { url: string; headers: Record<string, string> } }>(as, "POST", "/images/uploads", { purpose: "brand_logo", contentType: "image/png", bytes: bytes.length });
  const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: bytes });
  if (!put.ok) throw new Error(`logo upload → ${put.status}`);
  return key;
}

/**
 * A verified brand `owner` owns, through the real API (ADR 0017): made if missing, its checklist filled in, the
 * business email confirmed by the code from Mailpit, sent for review and approved by `approver` (any dev header
 * passes requireAdmin; never someone on its team). Reused as it is when it's already verified. Returns its id.
 */
export async function verifiedBrand(owner: string, handle: string, name: string, approver: string): Promise<string> {
  const mine = await api<{ brands: { id: string; handle: string; verificationStatus: string }[] }>(owner, "GET", "/me/brands");
  let id = mine.brands.find((b) => b.handle === handle)?.id;
  if (id && mine.brands.find((b) => b.id === id)!.verificationStatus === "verified") return id;
  if (!id) id = (await api(owner, "POST", "/brands", { name, handle, logoEmoji: "🏷️", lane: "General knowledge" })).id as string;
  const domain = `${handle.replace(/[^a-z0-9]/g, "")}.example`;
  await api(owner, "PATCH", `/brands/${id}`, { registrationNumber: "RC1234567", logoKey: await uploadLogo({ person: owner, brand: handle }), siteUrl: `https://${domain}`, cashPrizes: false });
  const settings = await api(owner, "GET", `/brands/${id}/settings`);
  if (!settings.checklist.businessEmail) {
    const email = `team+${Date.now()}@${domain}`;
    await api(owner, "POST", `/brands/${id}/business-email/start`, { email });
    await api(owner, "POST", `/brands/${id}/business-email/verify`, { email, code: await mailedCode(email) });
  }
  if (settings.verification.status !== "in_review") await api(owner, "POST", `/brands/${id}/verification/submit`);
  await api(approver, "POST", `/admin/brands/${id}/approve`, { reason: "Sim: checklist complete" });
  return id;
}

/** Put `member` on the brand's team with `role` through invites (idempotent: already on it, nothing changes). */
export async function onTeam(owner: string, brandId: string, member: string, role: "admin" | "host" | "viewer") {
  const team = await api<{ members: { handle: string; role: string }[] }>(owner, "GET", `/brands/${brandId}/team`);
  const there = team.members.find((m) => m.handle === member);
  if (there) {
    if (there.role !== role && there.role !== "owner") await api(owner, "PATCH", `/brands/${brandId}/members/${(await db.select({ id: users.id }).from(users).where(eq(users.handle, member)))[0].id}`, { role });
    return;
  }
  const { inviteId } = await api(owner, "POST", `/brands/${brandId}/invites`, { handle: member, role });
  await api(member, "POST", `/brand-invites/${inviteId}/accept`);
}
