/**
 * The three-beat party round (question → reveal → standings), as a pure state machine.
 * No timers and no I/O: every transition takes `now` (server epoch ms) from the caller, so the
 * realtime room owns the clock and this module owns the rules. Clients only ever submit answers.
 */
import { grade, publicView, revealAnswer, distribution, type QuestionFormat } from "./formats.js";
import { points, type ScoringConfig } from "./scoring.js";
import { computeStandings, rankMap, type StandingRow } from "./standings.js";

export interface MatchQuestion {
  id: string;
  format: QuestionFormat;
  /** Full server payload, correct answers included. Never sent to clients as-is. */
  payload: unknown;
  seconds: number;
  explanation?: string;
}

export interface RoundConfig extends ScoringConfig {
  revealSeconds: number;
  revealFloorSeconds: number;
  standingsSeconds: number;
  standingsFloorSeconds: number;
}

export type Beat = "idle" | "question" | "reveal" | "standings" | "finished";

export interface OpenQuestionView {
  idx: number;
  total: number;
  format: QuestionFormat;
  view: Record<string, unknown>;
  seconds: number;
  openedAt: number;
  closesAt: number;
}

export interface Verdict {
  userId: string;
  correctness: number;
  points: number;
  /** null = no answer submitted. */
  answeredMs: number | null;
}

export interface Reveal {
  idx: number;
  questionId: string;
  answer: Record<string, unknown>;
  explanation?: string;
  /** Per-option counts for option formats, null otherwise. Only exists after close. */
  distribution: number[] | null;
  answered: number;
  noAnswer: number;
  verdicts: Verdict[];
  endsAt: number;
  skippableAt: number;
}

interface Submission {
  answer: unknown;
  answeredMs: number;
  locked: boolean;
}

export class Match {
  readonly questions: MatchQuestion[];
  readonly cfg: RoundConfig;
  private beat: Beat = "idle";
  private idx = -1;
  private openedAt = 0;
  private submissions = new Map<string, Submission>();
  private players = new Map<string, { score: number; timeMs: number }>();
  private lastRanks: Map<string, number> | undefined;
  private lastReveal: Reveal | null = null;
  private lastStandings: StandingRow[] | null = null;
  private standingsEndsAt = 0;
  private standingsSkippableAt = 0;

  constructor(questions: MatchQuestion[], cfg: RoundConfig) {
    if (!questions.length) throw new Error("a match needs at least one question");
    this.questions = questions;
    this.cfg = cfg;
  }

  get currentBeat(): Beat {
    return this.beat;
  }
  get questionIdx(): number {
    return this.idx;
  }
  get current(): MatchQuestion {
    return this.questions[this.idx];
  }

  /** Players can join at any point (late joiners start at 0 and accrue full time for missed questions). */
  addPlayer(userId: string): void {
    if (!this.players.has(userId)) {
      const missedMs = this.questions.slice(0, Math.max(0, this.idx + (this.beat === "question" ? 0 : 1))).reduce((a, q) => a + q.seconds * 1000, 0);
      this.players.set(userId, { score: 0, timeMs: missedMs });
    }
  }
  hasPlayer(userId: string): boolean {
    return this.players.has(userId);
  }

  openQuestion(now: number): OpenQuestionView {
    if (this.beat !== "idle" && this.beat !== "standings") throw new Error(`cannot open a question during ${this.beat}`);
    this.idx += 1;
    if (this.idx >= this.questions.length) throw new Error("no questions left");
    this.beat = "question";
    this.openedAt = now;
    this.submissions = new Map();
    const q = this.current;
    return {
      idx: this.idx,
      total: this.questions.length,
      format: q.format,
      view: publicView(q.format, q.payload),
      seconds: q.seconds,
      openedAt: now,
      closesAt: now + q.seconds * 1000,
    };
  }

  /** Latest answer wins until the player locks in or the clock closes the question. */
  submitAnswer(userId: string, answer: unknown, now: number): { accepted: boolean; reason?: string } {
    if (this.beat !== "question") return { accepted: false, reason: "not_open" };
    if (!this.players.has(userId)) return { accepted: false, reason: "not_in_match" };
    const q = this.current;
    if (now > this.openedAt + q.seconds * 1000) return { accepted: false, reason: "too_late" };
    const existing = this.submissions.get(userId);
    if (existing?.locked) return { accepted: false, reason: "locked" };
    this.submissions.set(userId, { answer, answeredMs: now - this.openedAt, locked: false });
    return { accepted: true };
  }

  lockAnswer(userId: string): { locked: boolean } {
    const s = this.submissions.get(userId);
    if (this.beat !== "question" || !s) return { locked: false };
    s.locked = true;
    return { locked: true };
  }

  /** Close the question: grade everyone, accumulate scores and tie-break time, build the reveal. */
  closeQuestion(now: number): Reveal {
    if (this.beat !== "question") throw new Error(`cannot close during ${this.beat}`);
    const q = this.current;
    const questionMs = q.seconds * 1000;
    const verdicts: Verdict[] = [];
    for (const [userId, tally] of this.players) {
      const s = this.submissions.get(userId);
      if (!s) {
        tally.timeMs += questionMs;
        verdicts.push({ userId, correctness: 0, points: 0, answeredMs: null });
        continue;
      }
      const correctness = grade(q.format, q.payload, s.answer);
      const pts = points(correctness, s.answeredMs, questionMs, this.cfg);
      tally.score += pts;
      tally.timeMs += s.answeredMs;
      verdicts.push({ userId, correctness, points: pts, answeredMs: s.answeredMs });
    }
    this.beat = "reveal";
    this.lastReveal = {
      idx: this.idx,
      questionId: q.id,
      answer: revealAnswer(q.format, q.payload),
      explanation: q.explanation,
      distribution: distribution(q.format, q.payload, [...this.submissions.values()].map((s) => s.answer)),
      answered: this.submissions.size,
      noAnswer: this.players.size - this.submissions.size,
      verdicts,
      endsAt: now + this.cfg.revealSeconds * 1000,
      skippableAt: now + this.cfg.revealFloorSeconds * 1000,
    };
    return this.lastReveal;
  }

  /** Host may cut the reveal short, but never below the floor. */
  canSkipReveal(now: number): boolean {
    return this.beat === "reveal" && !!this.lastReveal && now >= this.lastReveal.skippableAt;
  }

  showStandings(now: number): { rows: StandingRow[]; endsAt: number; skippableAt: number } {
    if (this.beat !== "reveal") throw new Error(`standings follow a reveal, not ${this.beat}`);
    const rows = computeStandings(
      [...this.players.entries()].map(([userId, t]) => ({ userId, score: t.score, timeMs: t.timeMs })),
      this.lastRanks,
    );
    this.lastRanks = rankMap(rows);
    this.lastStandings = rows;
    this.beat = "standings";
    this.standingsEndsAt = now + this.cfg.standingsSeconds * 1000;
    this.standingsSkippableAt = now + this.cfg.standingsFloorSeconds * 1000;
    return { rows, endsAt: this.standingsEndsAt, skippableAt: this.standingsSkippableAt };
  }

  canSkipStandings(now: number): boolean {
    return this.beat === "standings" && now >= this.standingsSkippableAt;
  }

  get hasMoreQuestions(): boolean {
    return this.idx + 1 < this.questions.length;
  }

  /** After the final standings: freeze the match and return the final table. */
  finish(): StandingRow[] {
    if (this.beat !== "standings") throw new Error(`cannot finish during ${this.beat}`);
    if (this.hasMoreQuestions) throw new Error("questions remain");
    this.beat = "finished";
    return this.lastStandings!;
  }

  get finalStandings(): StandingRow[] | null {
    return this.beat === "finished" ? this.lastStandings : null;
  }
}
