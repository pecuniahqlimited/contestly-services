/**
 * TEST-ONLY helpers shared by the party sims: an API client with the dev identity header, an
 * assertion tally, and answer builders that read the server payload straight from Postgres.
 * Nothing like this exists in the product.
 */
import { and, eq, sql } from "drizzle-orm";
import { climbRounds, db, ledgerAccounts, ledgerEntries } from "@contestly/db";
import type { QuestionFormat } from "@contestly/game";
import { SOURCE_FILE_FIELD, type ClimbGameType } from "@contestly/shared";

export const API = process.env.API_URL ?? "http://localhost:4000";
export const RT = process.env.RT_URL ?? "ws://localhost:4001";

let failures = 0;
export const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? "✓" : "✗ FAIL"} ${label}`);
  if (!cond) failures++;
};
export const failureCount = () => failures;

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

/** Calls the API as a dev user. Returns { status, body } so callers can assert on refusals too. */
export async function call<T = any>(handle: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "x-dev-user": handle, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = res.status === 204 ? ({} as T) : ((await res.json().catch(() => ({}))) as T);
  return { status: res.status, body: json };
}

/** Sends a party's source file as multipart, as the app does. Returns { status, body }. */
export async function sendFile<T = any>(handle: string, partyId: string, file: { filename: string; contentType: string; bytes: Uint8Array<ArrayBuffer> }): Promise<{ status: number; body: T }> {
  const form = new FormData();
  form.append(SOURCE_FILE_FIELD, new Blob([file.bytes], { type: file.contentType }), file.filename);
  const res = await fetch(`${API}/parties/${partyId}/files`, { method: "PUT", headers: { "x-dev-user": handle }, body: form });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

/** Like call(), but throws on any non-2xx (except 402, which the sims assert on). */
export async function api<T = any>(handle: string, method: string, path: string, body?: unknown): Promise<T> {
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
  };
  return byType[r.gameType as ClimbGameType]();
}
export const wrongClimbAnswer = { index: -1, word: "zzzz", words: [], value: -999999, sequence: [] };

