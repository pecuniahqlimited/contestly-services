/**
 * The generate_set orchestrator: brief → spec → retrieve → generate → verify → embed → dedupe →
 * difficulty → safety → gate, then one transaction that fills the bank, writes a generation
 * record per draft, writes the set into party_questions (reserves last), stores the spec summary
 * and marks the set ready (ADR 0002).
 *
 * Sealed parties generate as soon as they're created, so the set is ready long before start and a
 * failure reaches the host while there's time to fix it. Curate parties generate when the host asks
 * for drafts (ADR 0003). If a sealed party went live while its set was still being built, the
 * start-time roster re-check runs straight after sealing, before the set is marked ready.
 *
 * Retrieval: open-knowledge parties reuse proven bank questions first, never one anyone seated has
 * already seen, and generate only the gap; file-sourced parties generate only from their files.
 *
 * Host-written questions (ADR 0015) are already in the set when this runs: the engine fills only the rest of
 * the play order (and the reserves), and the host's questions are spread through it (hostSlots).
 *
 * Fail closed: if the gate can't fill count + reserves, the records are still written, then the job
 * throws. BullMQ retries; the final failure marks the set failed and notifies the host (index.ts).
 */
import { and, asc, eq } from "drizzle-orm";
import { db, parties, partyQuestions, getQuestionsConfig, seenBySeated, type Party, type Tx } from "@contestly/db";
import { hostSlots, type QuestionFormat } from "@contestly/shared";
import type { Providers } from "../providers/types.js";
import { fillQuestions, persistFill } from "./fill.js";
import { assertSetFilled } from "./gate.js";
import { specFor } from "./partySpec.js";
import { resealForRoster } from "./reseal.js";
import { deckProgress, forgeReporter } from "./forge.js";

export interface GenerateSetDeps {
  providers: Providers;
  publish: (ev: { partyId: string; status: string }) => Promise<unknown>;
}

/** Sealed sets are built from creation until the round starts; curate drafts while the party is open. */
const generatesNow = (p: Party) => (p.mode === "sealed" ? p.status === "open" || p.status === "live" : p.status === "open");

export async function generateSet(partyId: string, deps: GenerateSetDeps): Promise<void> {
  const [party] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!party || !generatesNow(party)) return;

  // Replay (or a set built before this column existed): the set already exists — just finish it.
  const existing = await db.select({ id: partyQuestions.id }).from(partyQuestions)
    .where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.reserve, false), eq(partyQuestions.hostWritten, false))).limit(1);
  if (existing.length) return markReady(party, deps);

  await deps.publish({ partyId, status: "questions_generating" });
  const cfg = await getQuestionsConfig();
  const spec = await specFor(party);
  // The host's own questions take their share of the play order; the engine makes the rest, plus the reserves.
  const hostCount = party.hostQuestionCount;
  const need = party.questionCount - hostCount + cfg.reserveCount;
  // Nobody seated gets a question they've already seen; if that leaves the bank short, generation fills the gap.
  const seen = await seenBySeated(partyId);
  const fill = await fillQuestions({
    spec, providers: deps.providers, want: need, playSize: party.questionCount, excludeBankIds: seen.map((s) => s.bankId), avoidPayloads: seen.map((s) => s.payload),
    progress: forgeReporter(partyId, party.questionCount - hostCount, deps.publish),
  });

  if (fill.picked.length < need) {
    // Keep the audit trail of the failed attempt (nothing enters the bank or the party set), then fail closed.
    await db.transaction((tx) => persistFill(tx, fill, { partyId, brief: party.brief, spec, banked: false }));
    assertSetFilled(fill.picked.length, need, fill.unavailable);
  }

  const wentLive = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (!locked || !generatesNow(locked)) return null; // cancelled meanwhile: nothing to seal
    // The API refuses host-question changes while a set is generating; a change before that is a retry.
    if (locked.hostQuestionCount !== hostCount) throw new Error(`generate ${partyId}: host-written questions changed (${hostCount} → ${locked.hostQuestionCount})`);
    await persistFill(tx, fill, { partyId, brief: party.brief, spec, banked: true });
    const order = await layOutPlayOrder(tx, party, fill.picked.map((q) => q.format));
    await tx.insert(partyQuestions).values(fill.picked.map((q, i) => ({
      partyId,
      idx: order.generatedIdx[i],
      format: q.format,
      payload: q.payload,
      seconds: party.questionSeconds,
      explanation: q.explanation,
      reserve: order.generatedIdx[i] >= party.questionCount,
      sourceRef: q.bankId,
      status: party.mode === "curate" ? ("draft" as const) : ("pending" as const),
    }))).onConflictDoNothing();
    // A sealed party that started while we were building isn't ready until the roster re-check has run.
    const live = locked.mode === "sealed" && locked.status === "live";
    // The deck as it will play: the play order's formats (reserves aren't cards).
    const deck = deckProgress("balance", order.formats, party.questionCount);
    await tx.update(parties).set({ specSummary: spec.summary, category: spec.categoryTag, questionsStatus: live ? "generating" : "ready", questionsError: null, forgeProgress: deck }).where(eq(parties.id, partyId));
    return live;
  });
  if (wentLive === null) return;

  const bankCount = fill.retrievedCount;
  console.log(`[questions] ${party.title}: ${party.mode === "sealed" ? "sealed" : "drafted"} ${party.questionCount - hostCount}+${cfg.reserveCount} reserve${hostCount ? ` beside ${hostCount} host-written` : ""} (${bankCount} from bank, ${seen.length} skipped as already seen, ${need - bankCount} generated${spec.sourceScope === "open" ? "" : " from file"}, ${fill.judged.length - fill.accepted.length} rejected${fill.unavailable.length ? `; ${fill.unavailable.join(", ")} unavailable, bank-only from there` : ""})`);
  if (wentLive) await resealForRoster(partyId, deps);
  else await deps.publish({ partyId, status: "questions_ready" });
}

/**
 * Where everything goes: the host-written questions on their slots through the play order (moved there now), the
 * generated ones on the other places in the order they were picked, then the reserves after the play order.
 * Returns each generated question's index and the play order's formats (the Forge's deck).
 */
async function layOutPlayOrder(tx: Tx, party: Party, picked: QuestionFormat[]) {
  const hostRows = await tx.select({ id: partyQuestions.id, format: partyQuestions.format }).from(partyQuestions)
    .where(and(eq(partyQuestions.partyId, party.id), eq(partyQuestions.hostWritten, true), eq(partyQuestions.reserve, false))).orderBy(asc(partyQuestions.idx));
  const total = party.questionCount;
  const slots = new Set(hostSlots(total, hostRows.length));
  // (party_id, idx) is unique: park the host's rows on free negative indexes before laying everything out.
  for (const [i, r] of hostRows.entries()) await tx.update(partyQuestions).set({ idx: -1 - i }).where(eq(partyQuestions.id, r.id));
  const generatedIdx: number[] = [];
  const formats: QuestionFormat[] = [];
  let h = 0;
  for (let pos = 0; pos < total; pos++) {
    if (slots.has(pos)) {
      await tx.update(partyQuestions).set({ idx: pos }).where(eq(partyQuestions.id, hostRows[h].id));
      formats.push(hostRows[h++].format);
    } else {
      formats.push(picked[generatedIdx.length]);
      generatedIdx.push(pos);
    }
  }
  while (generatedIdx.length < picked.length) generatedIdx.push(total + generatedIdx.length - (total - hostRows.length));
  return { generatedIdx, formats };
}

/** The set exists: make sure it's marked ready (running the roster re-check first if the party is live). */
async function markReady(party: Party, deps: GenerateSetDeps) {
  if (party.mode === "sealed" && party.status === "live") return resealForRoster(party.id, deps);
  await db.update(parties).set({ questionsStatus: "ready", questionsError: null }).where(eq(parties.id, party.id));
  await deps.publish({ partyId: party.id, status: "questions_ready" });
}
