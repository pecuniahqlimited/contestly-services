/**
 * The Climb's word list and per-stage settings against the real database: the starter list is seeded by the migration;
 * a paste gets a result per line and is logged; edits need a reason and are logged; a switched-off word leaves the
 * games' supply; the ladder carries its settings and warns about word supply; the preview samples a round with draft
 * settings; and a run plays a word search from the list, timed from its settings.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import { activeWordsFor, adminActions, climbRounds, climbRuns, climbWords, db, sql, type User } from "@contestly/db";
import { DEFAULT_CLIMB_LADDER, type ClimbLadderInput } from "@contestly/shared";
import { as, makeUser, tag, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let admin: User, player: User;

beforeAll(async () => {
  ({ app } = await testApp());
  admin = await makeUser("wordadmin", { isAdmin: true });
  player = await makeUser("wordplayer");
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

/** Letters only and unique per run, so reruns never collide: "zq" + the run tag spelled in letters. */
const runWord = (stem: string) => `${stem}${tag.replace(/\d/g, (d) => "abcdefghij"[Number(d)])}`.slice(0, 12);

describe("the word list", () => {
  it("starts with the starter list, for every word game", async () => {
    for (const game of ["scramble", "word_search", "word_hunt"] as const) expect(await activeWordsFor(db, game)).toContain("jollof");
  });

  it("a paste gets a result per line, adds the new words once, and is logged", async () => {
    const fresh = runWord("zq");
    const res = await app.inject({ method: "POST", url: "/admin/climb/words", headers: as(admin), payload: { text: `${fresh}\nJollof\nice-cream\n${fresh.toUpperCase()}\nab`, games: ["word_search"], theme: "Test" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: any) => [r.line, r.result, r.error])).toEqual([
      [1, "added", null], [2, "exists", null], [3, "invalid", "not_letters"], [4, "duplicate", null], [5, "invalid", "too_short"],
    ]);
    expect(res.json().added).toBe(1);
    expect(await activeWordsFor(db, "word_search")).toContain(fresh);
    expect(await activeWordsFor(db, "scramble")).not.toContain(fresh);
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.adminUserId, admin.id), eq(adminActions.action, "climb.words_add")));
    expect(log.after).toMatchObject({ words: [fresh], games: ["word_search"], theme: "test" });
  });

  it("lists by game, length and prefix, with the active supply per game", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/climb/words?game=scramble&length=6&q=jol", headers: as(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json().words.map((w: any) => w.word)).toEqual(["jollof"]);
    expect(res.json().activeByGame.scramble).toBeGreaterThan(100);
  });

  it("switching a word off needs a reason, takes it out of the games, and is logged", async () => {
    const word = runWord("zx");
    const added = await app.inject({ method: "POST", url: "/admin/climb/words", headers: as(admin), payload: { text: word } });
    expect(added.json().added).toBe(1);
    const [{ id }] = (await app.inject({ method: "GET", url: `/admin/climb/words?q=${word}`, headers: as(admin) })).json().words;
    expect((await app.inject({ method: "PATCH", url: `/admin/climb/words/${id}`, headers: as(admin), payload: { active: false } })).statusCode).toBe(400);
    const off = await app.inject({ method: "PATCH", url: `/admin/climb/words/${id}`, headers: as(admin), payload: { active: false, reason: "too obscure" } });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ word, active: false });
    expect(await activeWordsFor(db, "scramble")).not.toContain(word);
    const [log] = await db.select().from(adminActions).where(eq(adminActions.targetId, `climb_word:${word}`));
    expect(log).toMatchObject({ action: "climb.word_deactivate", reason: "too obscure" });
  });
});

describe("ladder settings", () => {
  const wordSearchLadder = (settings: Record<string, unknown>): ClimbLadderInput => ({
    enabledTypes: DEFAULT_CLIMB_LADDER.enabledTypes,
    stages: [{ types: ["word_search"], rounds: 1, toClear: 1, seconds: 10, points: 10, settings: { word_search: settings } }],
  });

  it("GET carries every stage's settings and no warnings on the starter list", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/climb/ladder", headers: as(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json().ladder.stages[2].settings.word_hunt).toEqual({ gridSize: 7, find: 3, minLength: 3, directions: "all" });
    expect(res.json().warnings).toEqual([]);
    expect(res.json().gameTypes).toHaveLength(7);
  });

  it("a bad setting is refused with its stage, type and setting in the path", async () => {
    const res = await app.inject({ method: "PUT", url: "/admin/climb/ladder", headers: as(admin), payload: { ladder: wordSearchLadder({ gridSize: 20 }) } });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toEqual(["ladder", "stages", 0, "settings", "word_search", "gridSize"]);
  });

  it("the preview warns about word supply and samples a round with the draft's settings", async () => {
    const ladder = wordSearchLadder({ gridSize: 12, words: 8, minLength: 10, maxLength: 12, secondsPerWord: 20 });
    const res = await app.inject({ method: "POST", url: "/admin/climb/ladder/preview", headers: as(admin), payload: { ladder, sample: { stage: 1, type: "word_search", round: 1 } } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // No 10–12 letter words on the starter list: thin, so a warning, but runs can widen, so it isn't blocking.
    expect(body.warnings).toEqual([expect.objectContaining({ stage: 1, type: "word_search", needed: 8, minLength: 10, maxLength: 12, available: 0, blocking: false })]);
    expect(body.sample).toMatchObject({ stage: 1, round: 1, type: "word_search" });
    expect(body.sample.seconds).toBe(body.sample.answer.placements.length * 20);
    expect(body.sample.view).not.toHaveProperty("placements");
    const bad = await app.inject({ method: "POST", url: "/admin/climb/ladder/preview", headers: as(admin), payload: { ladder, sample: { stage: 1, type: "scramble", round: 1 } } });
    expect(bad.json().error).toBe("type_not_in_stage");
  });

  it("a run plays the saved settings: a word search from the list, timed per word", async () => {
    const before = (await app.inject({ method: "GET", url: "/admin/climb/ladder", headers: as(admin) })).json();
    const ladder = wordSearchLadder({ gridSize: 8, words: 4, minLength: 4, maxLength: 6, secondsPerWord: 15 });
    expect((await app.inject({ method: "PUT", url: "/admin/climb/ladder", headers: as(admin), payload: { ladder } })).statusCode).toBe(200);
    try {
      const run = (await app.inject({ method: "POST", url: "/climb/runs", headers: as(player) })).json();
      expect(run.round).toMatchObject({ type: "word_search", seconds: 60 });
      expect(run.round.view.words).toHaveLength(4);
      expect(Date.parse(run.round.closesAt) - Date.parse(run.round.opensAt)).toBe(60_000);
      const [stored] = await db.select().from(climbRounds).where(eq(climbRounds.id, run.round.id));
      const placements = (stored.payload as any).placements as { word: string; cells: [number, number][] }[];
      const found = placements.map((p) => ({ word: p.word, cells: [...p.cells].reverse() }));
      const answered = await app.inject({ method: "POST", url: `/climb/runs/${run.run.id}/answer`, headers: as(player), payload: { roundId: run.round.id, answer: { found } } });
      expect(answered.json()).toMatchObject({ correct: true, stageOutcome: "cleared" });
      expect(answered.json().reveal.answer.placements).toHaveLength(4);
    } finally {
      await app.inject({ method: "PUT", url: "/admin/climb/ladder", headers: as(admin), payload: { ladder: before.ladder } });
    }
  });
});

describe("a short word list never stops a run", () => {
  const oneStage = (type: "scramble" | "word_hunt", settings: Record<string, unknown>): ClimbLadderInput => ({
    enabledTypes: DEFAULT_CLIMB_LADDER.enabledTypes,
    stages: [{ types: [type], rounds: 1, toClear: 1, seconds: 10, points: 10, settings: { [type]: settings } }],
  });
  /** Save a ladder for the test, run `work`, and put the ladder back. */
  async function withLadder(ladder: ClimbLadderInput, work: () => Promise<void>) {
    const before = (await app.inject({ method: "GET", url: "/admin/climb/ladder", headers: as(admin) })).json();
    expect((await app.inject({ method: "PUT", url: "/admin/climb/ladder", headers: as(admin), payload: { ladder } })).statusCode).toBe(200);
    try { await work(); } finally {
      await app.inject({ method: "PUT", url: "/admin/climb/ladder", headers: as(admin), payload: { ladder: before.ladder } });
    }
  }
  /** Take a game off every word for `work`, then give it back. */
  async function withoutWordsFor(game: "word_hunt", work: () => Promise<void>) {
    const taken = await db.update(climbWords).set({ games: dsql`array_remove(${climbWords.games}, ${game})` }).where(dsql`${game} = any(${climbWords.games})`).returning({ id: climbWords.id });
    try { await work(); } finally {
      await db.update(climbWords).set({ games: dsql`array_append(${climbWords.games}, ${game})` }).where(inArray(climbWords.id, taken.map((t) => t.id)));
    }
  }

  it("a stage's lengths the list can't supply widen to the nearest that it can", async () => {
    await withLadder(oneStage("scramble", { minLength: 12, maxLength: 12 }), async () => {
      const run = (await app.inject({ method: "POST", url: "/climb/runs", headers: as(player) })).json();
      expect(run.run.status).toBe("active");
      const [stored] = await db.select().from(climbRounds).where(eq(climbRounds.id, run.round.id));
      const longest = Math.max(...(await activeWordsFor(db, "scramble")).map((w) => w.length));
      expect((stored.payload as any).word).toHaveLength(longest);
    });
  });

  it("a player meets every fitting word once before any other length or repeat, and still gets rounds after", async () => {
    // 9-letter scrambles: few on the list, so a handful of runs use them all.
    const nine = (await activeWordsFor(db, "scramble")).filter((w) => w.length === 9);
    const fresh = await makeUser("wordrunner");
    await withLadder(oneStage("scramble", { minLength: 9, maxLength: 9 }), async () => {
      const got: string[] = [];
      for (let i = 0; i < nine.length + 2; i++) {
        const run = (await app.inject({ method: "POST", url: "/climb/runs", headers: as(fresh) })).json();
        expect(run.run.status).toBe("active");
        const [stored] = await db.select().from(climbRounds).where(eq(climbRounds.id, run.round.id));
        got.push((stored.payload as any).word);
      }
      // Every 9-letter word once before any length widens or repeats.
      expect(new Set(got.slice(0, nine.length))).toEqual(new Set(nine));
    });
  });

  it("a ladder the list can't supply at any length is refused at that stage's path", async () => {
    await withoutWordsFor("word_hunt", async () => {
      const res = await app.inject({ method: "PUT", url: "/admin/climb/ladder", headers: as(admin), payload: { ladder: oneStage("word_hunt", {}) } });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues[0].path).toEqual(["ladder", "stages", 0, "settings", "word_hunt"]);
      const preview = (await app.inject({ method: "POST", url: "/admin/climb/ladder/preview", headers: as(admin), payload: { ladder: oneStage("word_hunt", {}) } }));
      expect(preview.statusCode).toBe(422); // its sample round can't be made either
    });
  });

  it("with no usable word at all, the run ends cleanly as abandoned, its banked points kept, and nothing charged", async () => {
    const climber = await makeUser("wordclimber");
    const twoStages: ClimbLadderInput = {
      enabledTypes: DEFAULT_CLIMB_LADDER.enabledTypes,
      stages: [
        { types: ["quick_maths"], rounds: 1, toClear: 1, seconds: 10, points: 10, settings: {} },
        { types: ["word_hunt"], rounds: 1, toClear: 1, seconds: 10, points: 20, settings: {} },
      ],
    };
    await withLadder(twoStages, async () => {
      const run = (await app.inject({ method: "POST", url: "/climb/runs", headers: as(climber) })).json();
      const [stored] = await db.select().from(climbRounds).where(eq(climbRounds.id, run.round.id));
      await withoutWordsFor("word_hunt", async () => {
        const answered = await app.inject({ method: "POST", url: `/climb/runs/${run.run.id}/answer`, headers: as(climber), payload: { roundId: run.round.id, answer: { value: (stored.payload as any).value } } });
        expect(answered.statusCode).toBe(200);
        expect(answered.json()).toMatchObject({ correct: true, stageOutcome: "cleared", nextOpensAt: null, run: { status: "abandoned", stagesCleared: 1, points: 10 } });
      });
      const [row] = await db.select().from(climbRuns).where(eq(climbRuns.id, run.run.id));
      expect(row).toMatchObject({ status: "abandoned", points: 10 });
      expect(row.endedAt).not.toBeNull();
      expect(await db.select().from(climbRounds).where(eq(climbRounds.runId, run.run.id))).toHaveLength(1);
      const [{ n }] = await sql`select count(*)::int as n from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.user_id = ${climber.id}`;
      expect(n).toBe(0); // The Climb takes no entry, so there's nothing to refund
      // A new run starts as usual once there are words again.
      expect((await app.inject({ method: "POST", url: "/climb/runs", headers: as(climber) })).json().run.status).toBe("active");
    });
  });
});
