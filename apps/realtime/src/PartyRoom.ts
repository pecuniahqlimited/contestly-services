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
import { and, asc, eq } from "drizzle-orm";
import { db, parties, partyPlayers, partyQuestions, partyAnswers, chatMessages, getPartyConfig, type Party } from "@contestly/db";
import { resolveUser } from "@contestly/auth";
import { partyQueue } from "@contestly/queue";
import { MSG, PARTY_EVENTS_CHANNEL, chatSendSchema, partyRoomKey, type PartyConfig } from "@contestly/shared";
import { Match, fixtureQuestionSource, type MatchQuestion, type QuestionFormat, type Reveal } from "@contestly/game";

interface Member {
  id: string;
  handle: string;
  displayName: string;
  avatarEmoji: string;
}

type Phase = "lobby" | "question" | "reveal" | "standings" | "finished" | "cancelled";

const settleQueue = partyQueue();

export class PartyRoom extends Room {
  private partyId!: string;
  private party!: Party;
  private cfg!: PartyConfig;
  private match: Match | null = null;
  private phase: Phase = "lobby";
  private members = new Map<string, Member>(); // sessionId → member
  private lastBroadcast: { type: string; payload: unknown } | null = null;
  private pending?: { clear(): void };
  private heartbeat?: { clear(): void };
  private starting = false;

  async onCreate(options: { partyId?: string }) {
    const partyId = options?.partyId;
    if (!partyId || typeof partyId !== "string") throw new Error("partyId required");
    const [party] = await db.select().from(parties).where(eq(parties.id, partyId));
    if (!party) throw new Error("party not found");
    this.partyId = partyId;
    this.party = party;
    this.cfg = await getPartyConfig();
    this.maxClients = party.maxPlayers;

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

    // Chat is open in the lobby, during standings, and after the game — never while a question or reveal is up.
    this.onMessage(MSG.chat, async (client, raw) => {
      const me = client.auth as Member | undefined;
      if (!me) return;
      if (!["lobby", "standings", "finished"].includes(this.phase)) return client.send(MSG.error, { error: "chat_closed" });
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
      if (ev.status === "live") void this.startMatch();
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
    return { id: user.id, handle: user.handle, displayName: user.displayName, avatarEmoji: user.avatarEmoji } satisfies Member;
  }

  onJoin(client: Client) {
    const me = client.auth as Member;
    this.members.set(client.sessionId, me);
    this.match?.addPlayer(me.id);
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
    if (this.match || this.starting) return;
    this.starting = true;
    try {
      const questions = await this.loadOrCreateSet();
      this.cfg = await getPartyConfig();
      this.match = new Match(questions, this.cfg);
      const seated = await db.select({ userId: partyPlayers.userId }).from(partyPlayers).where(eq(partyPlayers.partyId, this.partyId));
      for (const s of seated) this.match.addPlayer(s.userId);
      for (const m of this.members.values()) this.match.addPlayer(m.id);
      // Heartbeat for the worker's watchdog: if this process dies mid-round, the key expires and the party is refunded.
      this.heartbeat = this.clock.setInterval(() => void this.presence.setex(partyRoomKey(this.partyId), "1", 30), 10_000);
      void this.presence.setex(partyRoomKey(this.partyId), "1", 30);
      this.nextQuestion();
    } finally {
      this.starting = false;
    }
  }

  /** Reuse a set already persisted for this party (room restart), else generate and persist one. */
  private async loadOrCreateSet(): Promise<MatchQuestion[]> {
    const existing = await db.select().from(partyQuestions).where(and(eq(partyQuestions.partyId, this.partyId), eq(partyQuestions.reserve, false))).orderBy(asc(partyQuestions.idx));
    if (existing.length) return existing.map((q) => ({ id: q.id, format: q.format as QuestionFormat, payload: q.payload, seconds: q.seconds, explanation: q.explanation ?? undefined }));
    const set = await fixtureQuestionSource.getSet({ partyId: this.partyId, category: this.party.category, count: this.party.questionCount, secondsPerQuestion: this.party.questionSeconds });
    const rows = [...set.questions, ...set.reserves].map((q, i) => ({
      id: q.id, partyId: this.partyId, idx: i, format: q.format, payload: q.payload, seconds: q.seconds, explanation: q.explanation, reserve: i >= set.questions.length,
    }));
    await db.insert(partyQuestions).values(rows).onConflictDoNothing();
    return set.questions;
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
    await this.persistQuestionResults(reveal);
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
    await db.update(partyQuestions).set({ status: "played" }).where(eq(partyQuestions.id, reveal.questionId));
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
    client.send(MSG.phase, { phase: this.phase, partyStatus: this.party.status });
    if (this.lastBroadcast && this.phase !== "lobby") client.send(this.lastBroadcast.type, this.lastBroadcast.payload);
  }

  /** Real presence only: the people actually connected to this room right now. */
  private broadcastPresence() {
    const seen = new Map<string, Member>();
    for (const m of this.members.values()) seen.set(m.id, m);
    this.broadcast(MSG.presence, { partyId: this.partyId, online: [...seen.values()] });
  }
}
