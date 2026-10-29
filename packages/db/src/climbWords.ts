/**
 * The Climb's word list in Postgres. Words are checked (checkClimbWord in @contestly/shared) by the caller before
 * they get here; this module only reads and writes them.
 */
import { and, asc, count, eq, inArray, like, sql as dsql, type SQL } from "drizzle-orm";
import { CLIMB_WORD_GAMES, type ClimbWordEntry, type ClimbWordGame } from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { climbWords, users, type ClimbWordRow } from "./schema.js";

type Conn = Tx | typeof db;

/** Active words a game may use, alphabetically (so a seeded generator picks the same words for the same list). */
export async function activeWordsFor(conn: Conn, game: ClimbWordGame): Promise<string[]> {
  const rows = await conn.select({ word: climbWords.word }).from(climbWords)
    .where(and(eq(climbWords.active, true), dsql`${game} = any(${climbWords.games})`)).orderBy(asc(climbWords.word));
  return rows.map((r) => r.word);
}

/** Every active word with its games: the supply the ladder editor's warnings count. */
export async function activeWordEntries(conn: Conn = db): Promise<ClimbWordEntry[]> {
  return conn.select({ word: climbWords.word, games: climbWords.games }).from(climbWords).where(eq(climbWords.active, true)).orderBy(asc(climbWords.word));
}

export interface WordFilter { game?: ClimbWordGame; theme?: string; length?: number; active?: boolean; q?: string; offset: number; limit: number }

/** A page of the list, alphabetical, with who added each word, the total matching, and active words per game. */
export async function listWords(f: WordFilter) {
  const where: SQL[] = [];
  if (f.game) where.push(dsql`${f.game} = any(${climbWords.games})`);
  if (f.theme) where.push(eq(climbWords.theme, f.theme));
  if (f.length) where.push(dsql`length(${climbWords.word}) = ${f.length}`);
  if (f.active !== undefined) where.push(eq(climbWords.active, f.active));
  if (f.q) where.push(like(climbWords.word, `${f.q.replace(/[%_\\]/g, "")}%`));
  const cond = where.length ? and(...where) : undefined;
  const [rows, [{ n }], perGame] = await Promise.all([
    db.select({ w: climbWords, handle: users.handle }).from(climbWords).leftJoin(users, eq(users.id, climbWords.addedByUserId))
      .where(cond).orderBy(asc(climbWords.word)).offset(f.offset).limit(f.limit),
    db.select({ n: count() }).from(climbWords).where(cond),
    Promise.all(CLIMB_WORD_GAMES.map(async (g) => [g, (await activeWordsFor(db, g)).length] as const)),
  ]);
  return { rows, total: Number(n), activeByGame: Object.fromEntries(perGame) as Record<ClimbWordGame, number> };
}

/** Which of these words are already on the list (active or not). */
export async function existingWords(conn: Conn, words: string[]): Promise<Set<string>> {
  if (!words.length) return new Set();
  const rows = await conn.select({ word: climbWords.word }).from(climbWords).where(inArray(climbWords.word, words));
  return new Set(rows.map((r) => r.word));
}

/** Add new words (already checked, none on the list yet). A word added meanwhile by someone else is skipped. */
export async function insertWords(conn: Conn, words: string[], fields: { games: ClimbWordGame[]; theme: string | null; addedByUserId: string }): Promise<ClimbWordRow[]> {
  if (!words.length) return [];
  return conn.insert(climbWords).values(words.map((word) => ({ word, ...fields }))).onConflictDoNothing({ target: climbWords.word }).returning();
}

export async function lockWord(tx: Tx, id: string): Promise<ClimbWordRow | undefined> {
  const [row] = await tx.select().from(climbWords).where(eq(climbWords.id, id)).for("update");
  return row;
}

export async function updateWord(tx: Tx, id: string, change: Partial<Pick<ClimbWordRow, "games" | "theme" | "active">>): Promise<ClimbWordRow> {
  const [row] = await tx.update(climbWords).set({ ...change, updatedAt: new Date() }).where(eq(climbWords.id, id)).returning();
  return row;
}

export const wordAddedBy = async (conn: Conn, row: ClimbWordRow) => {
  if (!row.addedByUserId) return null;
  const [u] = await conn.select({ id: users.id, handle: users.handle }).from(users).where(eq(users.id, row.addedByUserId));
  return u ?? null;
};
