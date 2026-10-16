/**
 * One Colyseus room per party: lobby presence, the three-beat round driven by packages/game,
 * and party chat. The room owns the clock; packages/game owns the rules. Live state lives in
 * this process (never in Valkey); Valkey carries presence, discovery, the worker's party:events
 * channel, and the heartbeat key the worker's watchdog refunds on if this process dies mid-round.
 *
 * Server authority: answers are stamped with the server clock on arrival; correct answers and
 * distributions are broadcast only after a question closes; clients only submit.
 */
// colyseus ships CJS with star re-exports Node's ESM lexer can't see; destructure the default.
import colyseus from "colyseus";
import type { Client } from "colyseus";
const { Room } = colyseus;
import { and, asc, eq, notInArray } from "drizzle-orm";
import { db, parties, partyPlayers, partyQuestions, partyAnswers, partyQuestionEvents, chatMessages, getPartyConfig, getQuestionsConfig, type Party } from "@contestly/db";
import { resolveUser } from "@contestly/auth";
import { partyQueue, questionsQueue } from "@contestly/queue";
import { MSG, PARTY_EVENTS_CHANNEL, chatSendSchema, flagSchema, partyRoomKey, type PartyConfig, type QuestionsConfig } from "@contestly/shared";
import { Match, flagThreshold, type MatchQuestion, type QuestionFormat, type Reveal } from "@contestly/game";

interface Member {
  id: string;
  handle: string;
  displayName: string;
  avatarEmoji: string;
  /** Seated players play; the host of a curate party is in the room but never in the match. */
  plays: boolean;
}

const toMatchQuestion = (q: typeof partyQuestions.$inferSelect): MatchQuestion =>
  ({ id: q.id, format: q.format as QuestionFormat, payload: q.payload, seconds: q.seconds, explanation: q.explanation ?? undefined });

type Phase = "lobby" | "generating" | "question" | "reveal" | "standings" | "finished" | "cancelled";

const settleQueue = partyQueue();
const questionJobs = questionsQueue();

export class PartyRoom extends Room {
  private partyId!: string;
  private party!: Party;
  private cfg!: PartyConfig;
  private qcfg!: QuestionsConfig;
  /** questionId → distinct flaggers. */
  private flags = new Map<string, Set<string>>();
  /** Question-result writes, serialised so a void never races the close that preceded it. */
  private persisting: Promise<unknown> = Promise.resolve();
  private match: Match | null = null;
  private phase: Phase = "lobby";
  private members = new Map<string, Member>(); // sessionId → member
  private lastBroadcast: { type: string; payload: unknown } | null = null;
  private pending?: { clear(): void };
  private heartbeat?: { clear(): void };
  private starting = false;
  private startAgain = false;

  async onCreate(options: { partyId?: string }) {
    const partyId = options?.partyId;
    if (!partyId || typeof partyId !== "string") throw new Error("partyId required");
    const [party] = await db.select().from(parties).where(eq(parties.id, partyId));
    if (!party) throw new Error("party not found");
    this.partyId = partyId;
    this.party = party;
    this.cfg = await getPartyConfig();
    this.qcfg = await getQuestionsConfig();
    this.maxClients = party.maxPlayers + 1; // + the curate host, who watches without a seat

    this.onMessage(MSG.answer, (client, data) => {
      if (!this.match || !client.auth) return;
      const res = this.match.submitAnswer((client.auth as Member).id, data, Date.now());
      if (!res.accepted) client.send(MSG.error, { error: res.reason });
    });

    this.onMessage(MSG.lock, (client) => {
      if (this.match && client.auth) this.match.lockAnswer((client.auth as Member).id);
    });

    // Host only: cut a reveal or standings short, never below the floor.
    this.onMessage(MSG.skip, (client) => {
      if (!this.match || (client.auth as Member)?.id !== this.party.createdByUserId) return;
      const now = Date.now();
      if (this.phase === "reveal" && this.match.canSkipReveal(now)) this.advance(() => this.showStandings());
      else if (this.phase === "standings" && this.match.canSkipStandings(now)) this.advance(() => this.afterStandings());
    });

    // Any player can flag the question on screen (or just revealed). Past the threshold it's voided for
    // everyone, with no host involvement.
    this.onMessage(MSG.flag, async (client, raw) => {
      const me = client.auth as Member | undefined;
      if (!this.match || !me) return;
      const parsed = flagSchema.safeParse(raw);
      if (!parsed.success) return client.send(MSG.error, { error: "validation", issues: parsed.error.issues });
      const q = this.match.current;
      if ((this.phase !== "question" && this.phase !== "reveal") || q?.id !== parsed.data.questionId) return client.send(MSG.error, { error: "flag_closed" });
      if (!this.match.hasPlayer(me.id)) return client.send(MSG.error, { error: "not_in_match" });
      if (this.match.isVoided(q.id)) return;
      const flaggers = this.flags.get(q.id) ?? new Set<string>();
      if (flaggers.has(me.id)) return;
      flaggers.add(me.id);
      this.flags.set(q.id, flaggers);
      await db.insert(partyQuestionEvents).values({ partyId: this.partyId, questionId: q.id, kind: "flag", userId: me.id, reason: parsed.data.reason });
      const threshold = flagThreshold(this.match.playerCount, this.qcfg);
      if (flaggers.size >= threshold && !this.match.isVoided(q.id)) await this.voidCurrent(q.id, flaggers.size, threshold);
    });

    // Chat is open in the lobby, during standings, and after the game — never while a question or reveal is up.
    this.onMessage(MSG.chat, async (client, raw) => {
      const me = client.auth as Member | undefined;
      if (!me) return;
      if (!["lobby", "generating", "standings", "finished"].includes(this.phase)) return client.send(MSG.error, { error: "chat_closed" });
      const parsed = chatSendSchema.safeParse(raw);
      if (!parsed.success) return client.send(MSG.error, { error: "validation", issues: parsed.error.issues });
      const [saved] = await db.insert(chatMessages).values({ partyId: this.partyId, userId: me.id, text: parsed.data.text, sticker: parsed.data.sticker }).returning();
      this.broadcast(MSG.chatMessage, { ...saved, handle: me.handle, displayName: me.displayName, avatarEmoji: me.avatarEmoji });
    });

    // Worker → realtime: party lifecycle events over Valkey, never HTTP.
    // RedisPresence JSON-parses published messages before invoking callbacks (LocalPresence doesn't),
    // so accept both shapes and never throw here: a throw would break delivery to every other room.
    this.presence.subscribe(PARTY_EVENTS_CHANNEL, (raw: unknown) => {
      let ev: { partyId: string; status: string };
      try {
        ev = typeof raw === "string" ? JSON.parse(raw) : (raw as { partyId: string; status: string });
      } catch {
        return;
      }
      if (ev.partyId !== this.partyId) return;
      // "live" usually arrives before the set is sealed; the room waits and "questions_ready" starts the round.
      if (ev.status === "live" || ev.status === "questions_ready") void this.startMatch();
      if (ev.status === "cancelled") {
        this.setPhase("cancelled");
        this.broadcast(MSG.phase, { phase: "cancelled" });
        void this.disconnect();
      }
    });

    // Room created after the party already went live (e.g. everyone reconnecting): pick the round up.
    if (party.status === "live") void this.startMatch();
  }

  /** Dev header or Firebase token, same as the API. Only seated players (and the creator) may enter the room. */
  async onAuth(_client: Client, options: { token?: string; devUser?: string }) {
    const { user } = await resolveUser({ authorization: options?.token ? `Bearer ${options.token}` : undefined, devUser: options?.devUser });
    if (!user) throw new Error("unauthorized");
    const seated = await db.select().from(partyPlayers).where(and(eq(partyPlayers.partyId, this.partyId), eq(partyPlayers.userId, user.id)));
    if (!seated.length && user.id !== this.party.createdByUserId) throw new Error("join_the_party_first");
    return { id: user.id, handle: user.handle, displayName: user.displayName, avatarEmoji: user.avatarEmoji, plays: seated.length > 0 } satisfies Member;
  }

  onJoin(client: Client) {
    const me = client.auth as Member;
    this.members.set(client.sessionId, me);
    if (me.plays) this.match?.addPlayer(me.id);
    this.broadcastPresence();
    this.sendSnapshot(client);
  }

  async onLeave(client: Client, consented: boolean) {
    this.members.delete(client.sessionId);
    this.broadcastPresence();
    if (consented || this.phase === "finished" || this.phase === "cancelled") return;
    try {
      await this.allowReconnection(client, this.cfg.reconnectGraceSeconds);
      this.members.set(client.sessionId, client.auth as Member);
      this.broadcastPresence();
      this.sendSnapshot(client);
    } catch {
      /* grace expired; the player stays in the match and scores 0 until they rejoin */
    }
  }

  onDispose() {
    this.heartbeat?.clear();
  }

  // ---- round driving ----------------------------------------------------------------

  private async startMatch() {
    if (this.match) return;
    // questions_ready can land while the "live" attempt is still reading an empty set; remember to retry.
    if (this.starting) {
      this.startAgain = true;
      return;
    }
    this.starting = true;
    try {
      // Heartbeat before anything else: the party is live, so the watchdog must see this room —
      // including while it's still waiting for the questions service to seal the set.
      this.startHeartbeat();
      const questions = await this.loadSet();
      if (!questions.length) {
        // The set isn't sealed yet; questions_ready will call startMatch again.
        this.setPhase("generating");
        this.broadcast(MSG.phase, { phase: "generating" });
        return;
      }
      this.cfg = await getPartyConfig();
      this.qcfg = await getQuestionsConfig();
      this.match = new Match(questions, this.cfg);
      // Seats are the match: a curate host (or anyone else unseated) watches but never plays.
      const seated = await db.select({ userId: partyPlayers.userId }).from(partyPlayers).where(eq(partyPlayers.partyId, this.partyId));
      for (const s of seated) this.match.addPlayer(s.userId);
      this.nextQuestion();
    } finally {
      this.starting = false;
      if (this.startAgain) {
        this.startAgain = false;
        if (!this.match) void this.startMatch();
      }
    }
  }

  /** If this process dies mid-round, the key expires and the worker's watchdog refunds the party. */
  private startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = this.clock.setInterval(() => void this.presence.setex(partyRoomKey(this.partyId), "1", 30), 10_000);
    void this.presence.setex(partyRoomKey(this.partyId), "1", 30);
  }

  /** The play order sealed (or approved) for this party; empty while generation is still running. */
  private async loadSet(): Promise<MatchQuestion[]> {
    const rows = await db.select().from(partyQuestions)
      .where(and(eq(partyQuestions.partyId, this.partyId), eq(partyQuestions.reserve, false), notInArray(partyQuestions.status, ["voided", "draft"])))
      .orderBy(asc(partyQuestions.idx));
    return rows.map(toMatchQuestion);
  }

  private nextQuestion() {
    const view = this.match!.openQuestion(Date.now());
    this.setPhase("question");
    this.remember(MSG.question, view);
    this.broadcast(MSG.question, view);
    this.schedule(view.seconds * 1000, () => this.closeQuestion());
  }

  private async closeQuestion() {
    const now = Date.now();
    const reveal = this.match!.closeQuestion(now);
    this.setPhase("reveal");
    this.remember(MSG.reveal, reveal);
    this.broadcast(MSG.reveal, reveal);
    this.schedule(this.cfg.revealSeconds * 1000, () => this.showStandings());
    await this.serialise(() => this.persistQuestionResults(reveal));
  }

  /**
   * Flags crossed the threshold: void the question for everyone. Open → nobody scores it; in its
   * reveal → its points come back off. The first approved reserve is appended as a replacement, the
   * room is told, and the tally, threshold and swap are logged for the party.
   */
  private async voidCurrent(questionId: string, flaggers: number, threshold: number) {
    const during = this.phase;
    const reveal = this.match!.voidQuestion(questionId, Date.now()); // sync, before any await: voids exactly once
    this.pending?.clear();
    this.setPhase("reveal");
    this.remember(MSG.reveal, reveal);
    this.broadcast(MSG.reveal, reveal);

    const replacement = await this.promoteReserve();
    if (replacement) this.match!.appendQuestion(toMatchQuestion(replacement));
    this.broadcast(MSG.questionVoided, { questionId, idx: reveal.idx, replacementAdded: !!replacement, total: this.match!.totalQuestions });
    this.schedule(Math.max(0, reveal.endsAt - Date.now()), () => this.showStandings());

    await this.serialise(() => db.transaction(async (tx) => {
      await tx.update(partyQuestions).set({ status: "voided" }).where(eq(partyQuestions.id, questionId));
      await tx.update(partyAnswers).set({ points: 0 }).where(eq(partyAnswers.questionId, questionId));
      await tx.insert(partyQuestionEvents).values({ partyId: this.partyId, questionId, kind: "void", detail: { flaggers, threshold, playerCount: this.match!.playerCount, during } });
      if (replacement) await tx.insert(partyQuestionEvents).values({ partyId: this.partyId, questionId: replacement.id, kind: "replace", detail: { replacedQuestionId: questionId } });
    }));
    await questionJobs.add("question_voided", { kind: "question_voided", partyQuestionId: questionId, flags: flaggers });
  }

  /** The first approved, unused reserve joins the play order (it already sits after it by idx). */
  private async promoteReserve() {
    const [next] = await db.select().from(partyQuestions)
      .where(and(eq(partyQuestions.partyId, this.partyId), eq(partyQuestions.reserve, true), eq(partyQuestions.status, "pending")))
      .orderBy(asc(partyQuestions.idx)).limit(1);
    if (!next) return null;
    await db.update(partyQuestions).set({ reserve: false }).where(eq(partyQuestions.id, next.id));
    return next;
  }

  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const run = this.persisting.then(work);
    this.persisting = run.catch(() => undefined); // one failed write mustn't wedge every later one
    return run;
  }

  private showStandings() {
    const standings = this.match!.showStandings(Date.now());
    this.setPhase("standings");
    const payload = { ...standings, chatOpen: true, lastQuestion: !this.match!.hasMoreQuestions };
    this.remember(MSG.standings, payload);
    this.broadcast(MSG.standings, payload);
    this.schedule(this.cfg.standingsSeconds * 1000, () => this.afterStandings());
  }

  private afterStandings() {
    if (this.match!.hasMoreQuestions) this.nextQuestion();
    else void this.finishMatch();
  }

  private async finishMatch() {
    const final = this.match!.finish();
    this.setPhase("finished");
    this.heartbeat?.clear();
    await db.transaction(async (tx) => {
      for (const row of final) {
        await tx.update(partyPlayers).set({ score: row.score, rank: row.rank }).where(and(eq(partyPlayers.partyId, this.partyId), eq(partyPlayers.userId, row.userId)));
      }
    });
    // Money and the status flip to `finished` happen in the worker (settle job), never here.
    await settleQueue.add("settle", { kind: "settle", partyId: this.partyId }, { jobId: `settle-${this.partyId}` });
    this.remember(MSG.finalStandings, { rows: final });
    this.broadcast(MSG.finalStandings, { rows: final });
  }

  private async persistQuestionResults(reveal: Reveal) {
    const rows = reveal.verdicts.map((v) => ({
      partyId: this.partyId,
      questionId: reveal.questionId,
      userId: v.userId,
      answer: v.answer,
      answeredMs: v.answeredMs,
      correctness: Math.round(v.correctness * 100),
      points: v.points,
    }));
    if (rows.length) await db.insert(partyAnswers).values(rows).onConflictDoNothing();
    await db.update(partyQuestions).set({ status: "played" }).where(and(eq(partyQuestions.id, reveal.questionId), eq(partyQuestions.status, "pending")));
  }

  // ---- plumbing ---------------------------------------------------------------------

  private schedule(ms: number, fn: () => void) {
    this.pending?.clear();
    this.pending = this.clock.setTimeout(fn, ms);
  }

  /** Host skip: cancel the pending timer and advance now. */
  private advance(fn: () => void) {
    this.pending?.clear();
    fn();
  }

  private setPhase(p: Phase) {
    this.phase = p;
  }

  private remember(type: string, payload: unknown) {
    this.lastBroadcast = { type, payload };
  }

  /** Late joiners and reconnections get the current beat so they land on the right screen. */
  private sendSnapshot(client: Client) {
    client.send(MSG.phase, {
      phase: this.phase,
      partyStatus: this.party.status,
      // Always disclosed: AI-generated, and sealed (nobody saw them first) or host-reviewed.
      questions: { aiGenerated: true, review: this.party.mode === "curate" ? "host_reviewed" : "sealed" },
    });
    if (this.lastBroadcast && this.phase !== "lobby") client.send(this.lastBroadcast.type, this.lastBroadcast.payload);
  }

  /** Real presence only: the people actually connected to this room right now. */
  private broadcastPresence() {
    const seen = new Map<string, Member>();
    for (const m of this.members.values()) seen.set(m.id, m);
    this.broadcast(MSG.presence, { partyId: this.partyId, online: [...seen.values()] });
  }
}
