/**
 * The onboarding round: three quick-fire questions, server-timed and scored like a party round
 * (packages/game's Match). Matchmaking (joinOrCreate) puts people onboarding at the same moment in one
 * room; it waits a few seconds for them, then locks and starts. Alone, it's a solo round paid by
 * points; with others, a shared round paid by rank, where everyone gets something. The player count
 * and roster it sends are the people actually in the room; there are no bots.
 * Coins are saved on the round, not the ledger: a guest gets them when they sign up.
 */
import { createHash } from "node:crypto";
import colyseus from "colyseus";
import type { Client } from "colyseus";
const { Room } = colyseus;
import { getOnboardingConfig, onboardingQuestions, playedOnboarding, recordOnboardingRound } from "@contestly/db";
import { resolveUser } from "@contestly/auth";
import { MSG, ONBOARDING_MSG, sharedCoins, soloCoins, type OnboardingConfig, type OnboardingResult } from "@contestly/shared";
import { Match, type MatchQuestion, type QuestionFormat, type StandingRow } from "@contestly/game";

interface Player {
  id: string;
  displayName: string;
  avatarEmoji: string;
  lanes: string[];
  /** SHA-256 of the app's device id, for the once-per-device bonus check. */
  deviceHash: string | null;
}

type Phase = "waiting" | "playing" | "finished";

const RECONNECT_SECONDS = 20;
const MAX_DEVICE_ID_CHARS = 200;

export class OnboardingRoom extends Room {
  private cfg!: OnboardingConfig;
  private phase: Phase = "waiting";
  private startsAt = 0;
  private players = new Map<string, Player>(); // userId → player
  private match: Match | null = null;
  private correct = new Map<string, number>();
  private questionIds: string[] = [];
  private pending?: { clear(): void };

  async onCreate() {
    this.cfg = await getOnboardingConfig();
    this.maxClients = this.cfg.maxPlayers;
    this.startsAt = Date.now() + this.cfg.waitSeconds * 1000;
    this.pending = this.clock.setTimeout(() => this.startSafely(), this.cfg.waitSeconds * 1000);
    this.onMessage(MSG.answer, (client, data) => {
      const me = client.auth as Player | undefined;
      if (!this.match || !me) return;
      const res = this.match.submitAnswer(me.id, data, Date.now());
      if (!res.accepted) client.send(MSG.error, { error: res.reason });
    });
  }

  /** Any session (guests are the usual case), once per account. */
  async onAuth(_client: Client, options: { token?: string; devUser?: string; deviceId?: string }) {
    const { user } = await resolveUser({ authorization: options?.token ? `Bearer ${options.token}` : undefined, devUser: options?.devUser });
    if ((await playedOnboarding([user.id])).has(user.id)) throw new Error("already_played");
    const deviceId = typeof options?.deviceId === "string" ? options.deviceId.slice(0, MAX_DEVICE_ID_CHARS) : "";
    return {
      id: user.id, displayName: user.displayName, avatarEmoji: user.avatarEmoji, lanes: user.interests,
      deviceHash: deviceId ? createHash("sha256").update(deviceId).digest("hex") : null,
    } satisfies Player;
  }

  onJoin(client: Client) {
    const me = client.auth as Player;
    if (this.players.has(me.id)) return; // the same account twice (two tabs): one seat
    this.players.set(me.id, me);
    this.broadcastLobby();
    if (this.players.size >= this.maxClients) this.startNow();
  }

  async onLeave(client: Client, consented: boolean) {
    const me = client.auth as Player;
    if (this.phase === "waiting") {
      if (![...this.clients].some((c) => (c.auth as Player)?.id === me.id)) this.players.delete(me.id);
      this.broadcastLobby();
      return;
    }
    if (consented || this.phase === "finished") return;
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      /* gone: they stay in the match and score 0 for what they miss */
    }
  }

  onDispose() {
    this.pending?.clear();
  }

  /** The real people in the room, and when it starts. */
  private broadcastLobby() {
    this.broadcast(ONBOARDING_MSG.lobby, {
      players: this.players.size,
      roster: [...this.players.values()].map(({ id, displayName, avatarEmoji }) => ({ id, displayName, avatarEmoji })),
      startsAt: new Date(this.startsAt).toISOString(),
    });
  }

  private startNow() {
    this.pending?.clear();
    this.startSafely();
  }

  /** A round that can't start ends this room only: the players are told, and the process keeps serving every other room. */
  private startSafely() {
    this.start().catch((err) => this.abandon("round_failed", err));
  }

  private abandon(error: string, cause?: unknown) {
    console.error(`[onboarding ${this.roomId}] ${error}`, cause ?? "");
    this.phase = "finished";
    this.pending?.clear();
    this.broadcast(MSG.error, { error });
    void this.disconnect();
  }

  private async start() {
    if (this.phase !== "waiting" || !this.players.size) return;
    this.phase = "playing";
    await this.lock();
    const lanes = [...new Set([...this.players.values()].flatMap((p) => p.lanes))];
    const bank = await onboardingQuestions(lanes, this.cfg.questionCount, this.cfg.maxDifficulty);
    if (bank.length < this.cfg.questionCount) return this.abandon("no_questions", `only ${bank.length} easy pick-one questions in the bank; need ${this.cfg.questionCount}`);
    this.questionIds = bank.map((q) => q.id);
    const questions: MatchQuestion[] = bank.map((q) => ({ id: q.id, format: q.format as QuestionFormat, payload: q.payload, seconds: this.cfg.questionSeconds, explanation: q.explanation ?? undefined }));
    this.match = new Match(questions, { basePoints: this.cfg.basePoints, maxSpeedBonus: this.cfg.maxSpeedBonus, revealSeconds: this.cfg.revealSeconds, revealFloorSeconds: this.cfg.revealSeconds, standingsSeconds: this.cfg.standingsSeconds, standingsFloorSeconds: this.cfg.standingsSeconds });
    for (const id of this.players.keys()) this.match.addPlayer(id);
    this.broadcastLobby();
    this.nextQuestion();
  }

  private nextQuestion() {
    const view = this.match!.openQuestion(Date.now());
    this.broadcast(MSG.question, view);
    this.schedule(view.seconds * 1000, () => this.closeQuestion());
  }

  private closeQuestion() {
    const reveal = this.match!.closeQuestion(Date.now());
    for (const v of reveal.verdicts) if (v.correctness === 1) this.correct.set(v.userId, (this.correct.get(v.userId) ?? 0) + 1);
    this.broadcast(MSG.reveal, reveal);
    this.schedule(this.cfg.revealSeconds * 1000, () => this.showStandings());
  }

  private showStandings() {
    const standings = this.match!.showStandings(Date.now());
    this.broadcast(MSG.standings, { ...standings, chatOpen: false, lastQuestion: !this.match!.hasMoreQuestions });
    this.schedule(this.cfg.standingsSeconds * 1000, () => (this.match!.hasMoreQuestions ? this.nextQuestion() : this.finish().catch((err) => this.abandon("round_failed", err))));
  }

  private async finish() {
    const rows = this.match!.finish();
    this.phase = "finished";
    this.broadcast(MSG.finalStandings, { rows });
    const results = new Map(rows.map((r) => [r.userId, this.resultFor(r, rows.length)]));
    for (const [userId, r] of results) {
      const p = this.players.get(userId)!;
      await recordOnboardingRound({
        userId, mode: r.mode, players: r.players, points: r.points, correct: r.correct, questions: r.questions, rank: r.rank,
        coinsKobo: r.coinsKobo, deviceHash: p.deviceHash, bankQuestionIds: this.questionIds,
      });
    }
    for (const client of this.clients) {
      const r = results.get((client.auth as Player).id);
      if (r) client.send(ONBOARDING_MSG.result, r);
    }
  }

  private resultFor(row: StandingRow, players: number): OnboardingResult {
    const mode = players > 1 ? "shared" : "solo";
    return {
      mode, points: row.score, correct: this.correct.get(row.userId) ?? 0, questions: this.match!.totalQuestions, rank: row.rank, players,
      coinsKobo: mode === "solo" ? soloCoins(row.score, this.cfg.soloTiers) : sharedCoins(row.rank, this.cfg.sharedByRankKobo),
    };
  }

  private schedule(ms: number, fn: () => void) {
    this.pending?.clear();
    this.pending = this.clock.setTimeout(fn, ms);
  }
}
