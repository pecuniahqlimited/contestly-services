import { describe, expect, it } from "vitest";
import { Match, type MatchQuestion, type Reveal, type RoundConfig } from "../src/round.js";
import { standingsFromRecords, type RecordedAnswer } from "../src/standings.js";

const cfg: RoundConfig = { basePoints: 100, maxSpeedBonus: 100, revealSeconds: 6, revealFloorSeconds: 3, standingsSeconds: 7, standingsFloorSeconds: 2 };
const q = (id: string, seconds = 10): MatchQuestion => ({ id, format: "pick_one", payload: { question: id, options: ["a", "b", "c", "d"], correctIndex: 2 }, seconds });

/** What the room writes to party_answers from a reveal (a voided one is written with 0 points). */
const record = (r: Reveal): RecordedAnswer[] => r.verdicts.map((v) => ({ questionId: r.questionId, userId: v.userId, points: r.voided ? 0 : v.points, answeredMs: v.answeredMs }));

describe("standingsFromRecords", () => {
  it("rebuilds exactly the standings the match ends with: voids, a late joiner, no-answers and ties", () => {
    const qs = [q("q1"), q("q2", 15), q("q3"), q("q4", 20)];
    const m = new Match(qs, cfg);
    for (const u of ["ada", "tunde", "zee"]) m.addPlayer(u);
    const answers: RecordedAnswer[] = [];
    let t = 1_000_000;
    const beat = (picks: [string, number, number][], voidIt = false) => {
      const open = m.openQuestion(t);
      for (const [u, index, after] of picks) m.submitAnswer(u, { index }, t + after);
      let reveal = m.closeQuestion(t + open.seconds * 1000);
      if (voidIt) reveal = m.voidQuestion(reveal.questionId, t + open.seconds * 1000 + 500);
      answers.push(...record(reveal));
      m.showStandings(t + open.seconds * 1000 + 6_000);
      t += 60_000;
      return reveal.questionId;
    };
    beat([["ada", 2, 1_000], ["tunde", 2, 4_000], ["zee", 0, 2_000]]);
    beat([["ada", 2, 3_000], ["tunde", 2, 1_000]], true); // voided in its reveal: counts for nobody
    m.addPlayer("kemi"); // late: q1 counts its full time, no points
    beat([["kemi", 2, 500], ["zee", 2, 9_000]]);
    beat([["ada", 1, 1_000], ["tunde", 2, 19_000], ["kemi", 2, 2_000]]); // zee doesn't answer

    const fromMatch = m.finish();
    const rebuilt = standingsFromRecords(["ada", "tunde", "zee", "kemi"], qs.map((x) => ({ id: x.id, seconds: x.seconds, voided: m.isVoided(x.id) })), answers);
    expect(rebuilt.map(({ userId, rank, score, timeMs }) => ({ userId, rank, score, timeMs })))
      .toEqual(fromMatch.map(({ userId, rank, score, timeMs }) => ({ userId, rank, score, timeMs })));
  });

  it("nobody answered anything: ranked by id, all on zero", () => {
    expect(standingsFromRecords(["b", "a"], [{ id: "q", seconds: 10, voided: false }], []).map((r) => [r.userId, r.rank, r.score, r.timeMs]))
      .toEqual([["a", 1, 0, 10_000], ["b", 2, 0, 10_000]]);
  });
});
