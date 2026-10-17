import { describe, expect, it } from "vitest";
import { Match, type MatchQuestion, type RoundConfig } from "../src/round.js";

const cfg: RoundConfig = { basePoints: 100, maxSpeedBonus: 100, revealSeconds: 6, revealFloorSeconds: 3, standingsSeconds: 7, standingsFloorSeconds: 2 };

const q = (id: string): MatchQuestion => ({
  id,
  format: "pick_one",
  payload: { question: id, options: ["a", "b", "c", "d"], correctIndex: 2 },
  seconds: 10,
});

function newMatch(questions = [q("q1"), q("q2")]) {
  const m = new Match(questions, cfg);
  for (const u of ["ada", "tunde", "zee"]) m.addPlayer(u);
  return m;
}

describe("the three-beat round", () => {
  it("plays question → reveal → standings → next, with server-set deadlines", () => {
    const m = newMatch();
    const t0 = 1_000_000;
    const open = m.openQuestion(t0);
    expect(open).toMatchObject({ idx: 0, total: 2, seconds: 10, openedAt: t0, closesAt: t0 + 10_000 });
    expect(open.view).not.toHaveProperty("correctIndex");

    expect(m.submitAnswer("ada", { index: 2 }, t0 + 1_000)).toEqual({ accepted: true });
    expect(m.submitAnswer("tunde", { index: 2 }, t0 + 8_000)).toEqual({ accepted: true });
    expect(m.submitAnswer("zee", { index: 0 }, t0 + 2_000)).toEqual({ accepted: true });

    const reveal = m.closeQuestion(t0 + 10_000);
    expect(reveal.answer).toEqual({ correctIndex: 2 });
    expect(reveal.distribution).toEqual([1, 0, 2, 0]);
    expect(reveal.noAnswer).toBe(0);
    const ada = reveal.verdicts.find((v) => v.userId === "ada")!;
    expect(ada.points).toBe(190); // 100 + 90% of the speed bonus
    expect(reveal.skippableAt).toBe(t0 + 10_000 + 3_000);

    const standings = m.showStandings(t0 + 16_000);
    expect(standings.rows.map((r) => r.userId)).toEqual(["ada", "tunde", "zee"]);
    expect(standings.rows.every((r) => r.prevRank === null)).toBe(true);

    const open2 = m.openQuestion(t0 + 23_000);
    expect(open2.idx).toBe(1);
  });

  it("answers stay changeable until the clock ends; the final change is graded at its own time", () => {
    const m = newMatch();
    const t0 = 0;
    m.openQuestion(t0);
    // ada: right early, then changes to wrong — the change counts
    expect(m.submitAnswer("ada", { index: 2 }, t0 + 1_000)).toEqual({ accepted: true });
    expect(m.submitAnswer("ada", { index: 0 }, t0 + 4_000)).toEqual({ accepted: true });
    // tunde: wrong early, then right at 6s — scored as answered at 6s, not 1s
    m.submitAnswer("tunde", { index: 1 }, t0 + 1_000);
    m.submitAnswer("tunde", { index: 2 }, t0 + 6_000);
    // zee: right, and changes nothing — answered at 2s
    m.submitAnswer("zee", { index: 2 }, t0 + 2_000);
    // a change right on the deadline still counts; one after it doesn't
    expect(m.submitAnswer("zee", { index: 2 }, t0 + 10_000)).toEqual({ accepted: true });
    expect(m.submitAnswer("zee", { index: 0 }, t0 + 10_001)).toMatchObject({ accepted: false, reason: "too_late" });

    const reveal = m.closeQuestion(t0 + 10_000);
    const v = (u: string) => reveal.verdicts.find((x) => x.userId === u)!;
    expect(v("ada")).toMatchObject({ correctness: 0, points: 0, answeredMs: 4_000, answer: { index: 0 } });
    expect(v("tunde")).toMatchObject({ correctness: 1, answeredMs: 6_000, points: 140 }); // 100 + 40% of the speed bonus
    expect(v("zee")).toMatchObject({ correctness: 1, answeredMs: 10_000, points: 100 }); // the re-send at the deadline set its time
  });

  it("rejects answers after the deadline and from non-players", () => {
    const m = newMatch();
    m.openQuestion(0);
    expect(m.submitAnswer("ada", { index: 2 }, 10_001)).toMatchObject({ accepted: false, reason: "too_late" });
    expect(m.submitAnswer("ghost", { index: 2 }, 1_000)).toMatchObject({ accepted: false, reason: "not_in_match" });
  });

  it("verdicts carry what each player actually submitted", () => {
    const m = newMatch([q("q1")]);
    m.openQuestion(0);
    m.submitAnswer("ada", { index: 2 }, 1_000);
    m.submitAnswer("tunde", { index: 0 }, 2_000);
    const reveal = m.closeQuestion(10_000);
    expect(reveal.verdicts.find((v) => v.userId === "ada")!.answer).toEqual({ index: 2 });
    expect(reveal.verdicts.find((v) => v.userId === "tunde")!.answer).toEqual({ index: 0 });
    expect(reveal.verdicts.find((v) => v.userId === "zee")!.answer).toBeNull();
  });

  it("no answer earns 0 points and full time toward the tie-break", () => {
    const m = newMatch([q("q1")]);
    m.openQuestion(0);
    m.submitAnswer("ada", { index: 2 }, 4_000);
    const reveal = m.closeQuestion(10_000);
    expect(reveal.noAnswer).toBe(2);
    const rows = m.showStandings(16_000).rows;
    expect(rows[0]).toMatchObject({ userId: "ada", timeMs: 4_000 });
    expect(rows[1].timeMs).toBe(10_000);
  });

  it("host skip respects the floors", () => {
    const m = newMatch();
    m.openQuestion(0);
    m.closeQuestion(10_000);
    expect(m.canSkipReveal(12_000)).toBe(false); // 3s floor
    expect(m.canSkipReveal(13_000)).toBe(true);
    m.showStandings(13_000);
    expect(m.canSkipStandings(14_000)).toBe(false); // 2s floor
    expect(m.canSkipStandings(15_000)).toBe(true);
  });

  it("standings animate from prev_rank on later questions", () => {
    const m = newMatch();
    m.openQuestion(0);
    m.submitAnswer("ada", { index: 2 }, 1_000);
    m.submitAnswer("tunde", { index: 0 }, 1_000);
    m.closeQuestion(10_000);
    m.showStandings(16_000); // ada 1st, tunde behind
    m.openQuestion(23_000);
    m.submitAnswer("tunde", { index: 2 }, 23_500);
    m.closeQuestion(33_000);
    const rows = m.showStandings(39_000).rows;
    const tunde = rows.find((r) => r.userId === "tunde")!;
    expect(tunde.rank).toBe(1);
    expect(tunde.prevRank).toBeGreaterThan(1);
  });

  it("finishes only after the last standings and freezes the table", () => {
    const m = newMatch([q("q1")]);
    m.openQuestion(0);
    m.closeQuestion(10_000);
    expect(() => m.finish()).toThrow();
    m.showStandings(16_000);
    const final = m.finish();
    expect(final).toHaveLength(3);
    expect(m.currentBeat).toBe("finished");
    expect(() => m.openQuestion(99_000)).toThrow();
  });

  it("late joiners accrue full time for the questions they missed", () => {
    const m = new Match([q("q1"), q("q2")], cfg);
    m.addPlayer("early");
    m.openQuestion(0);
    m.submitAnswer("early", { index: 2 }, 1_000);
    m.closeQuestion(10_000);
    m.showStandings(16_000);
    m.addPlayer("late");
    m.openQuestion(23_000);
    m.submitAnswer("late", { index: 2 }, 23_100);
    m.submitAnswer("early", { index: 2 }, 23_100);
    m.closeQuestion(33_000);
    const rows = m.showStandings(39_000).rows;
    const late = rows.find((r) => r.userId === "late")!;
    expect(late.timeMs).toBeGreaterThanOrEqual(10_000); // missed q1 counts in full
    expect(rows[0].userId).toBe("early");
  });
});
