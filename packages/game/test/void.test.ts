import { describe, expect, it } from "vitest";
import { Match, type MatchQuestion, type RoundConfig } from "../src/round.js";
import { flagThreshold, shouldVoid } from "../src/flags.js";

const cfg: RoundConfig = { basePoints: 100, maxSpeedBonus: 100, revealSeconds: 6, revealFloorSeconds: 3, standingsSeconds: 7, standingsFloorSeconds: 2 };
const q = (id: string): MatchQuestion => ({ id, format: "pick_one", payload: { question: id, options: ["a", "b", "c", "d"], correctIndex: 2 }, seconds: 10 });

function played() {
  const m = new Match([q("q1"), q("q2")], cfg);
  for (const u of ["ada", "tunde", "zee"]) m.addPlayer(u);
  const t0 = 1_000_000;
  m.openQuestion(t0);
  m.submitAnswer("ada", { index: 2 }, t0 + 1_000);
  m.submitAnswer("tunde", { index: 2 }, t0 + 5_000);
  // zee doesn't answer
  return { m, t0 };
}

describe("flag threshold", () => {
  it("is the larger of the share and the floor", () => {
    const rule = { flagThresholdPct: 30, flagFloorPlayers: 3 };
    expect(flagThreshold(3, rule)).toBe(3); // floor wins
    expect(flagThreshold(20, rule)).toBe(6); // 30% of 20
    expect(flagThreshold(11, rule)).toBe(4); // ceil(3.3)
    expect(flagThreshold(0, rule)).toBe(3);
    expect(shouldVoid(2, 3, rule)).toBe(false);
    expect(shouldVoid(3, 3, rule)).toBe(true);
  });
});

describe("voiding a question", () => {
  it("while open: nothing is scored, the reveal is voided, time isn't charged", () => {
    const { m, t0 } = played();
    const reveal = m.voidQuestion("q1", t0 + 3_000);
    expect(reveal.voided).toBe(true);
    expect(reveal.verdicts.every((v) => v.points === 0)).toBe(true);
    expect(m.currentBeat).toBe("reveal");
    const rows = m.showStandings(t0 + 9_000).rows;
    expect(rows.every((r) => r.score === 0 && r.timeMs === 0)).toBe(true);
    expect(m.isVoided("q1")).toBe(true);
  });

  it("during its reveal: points and tie-break time are taken back exactly", () => {
    const { m, t0 } = played();
    const before = m.closeQuestion(t0 + 10_000);
    expect(before.verdicts.find((v) => v.userId === "ada")!.points).toBeGreaterThan(0);
    const reveal = m.voidQuestion("q1", t0 + 11_000);
    expect(reveal.voided).toBe(true);
    const rows = m.showStandings(t0 + 12_000).rows;
    for (const r of rows) {
      expect(r.score).toBe(0);
      expect(r.timeMs).toBe(0); // including zee's no-answer penalty
    }
  });

  it("refuses to void twice, a question that isn't current, or outside question/reveal", () => {
    const { m, t0 } = played();
    expect(() => m.voidQuestion("q2", t0)).toThrow();
    m.voidQuestion("q1", t0 + 1);
    expect(() => m.voidQuestion("q1", t0 + 2)).toThrow();
    m.showStandings(t0 + 3);
    expect(() => m.voidQuestion("q1", t0 + 4)).toThrow();
  });

  it("appends a replacement that plays at the end, and late joiners aren't charged for voided time", () => {
    const { m, t0 } = played();
    m.voidQuestion("q1", t0 + 1_000);
    m.appendQuestion(q("r1"));
    expect(m.totalQuestions).toBe(3);
    m.showStandings(t0 + 2_000);
    m.addPlayer("late"); // missed only the voided q1 → no time charged
    m.openQuestion(t0 + 3_000);
    m.closeQuestion(t0 + 13_000);
    const rows = m.showStandings(t0 + 14_000).rows;
    expect(rows.find((r) => r.userId === "late")!.timeMs).toBe(10_000); // only q2's no-answer
    expect(m.hasMoreQuestions).toBe(true);
    expect(m.openQuestion(t0 + 15_000)).toMatchObject({ idx: 2, total: 3 });
    expect(() => m.appendQuestion(q("r1"))).toThrow();
  });
});
