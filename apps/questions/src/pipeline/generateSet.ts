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
 * Fail closed: if the gate can't fill count + reserves, the records are still written, then the job
 * throws. BullMQ retries; the final failure marks the set failed and notifies the host (index.ts).
 */
import { and, eq } from "drizzle-orm";
import { db, parties, partyQuestions, getQuestionsConfig, seenBySeated, type Party } from "@contestly/db";
import type { Providers } from "../providers/types.js";
import { fillQuestions, persistFill } from "./fill.js";
import { assertSetFilled } from "./gate.js";
import { specFor } from "./partySpec.js";
import { resealForRoster } from "./reseal.js";

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
    .where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.reserve, false))).limit(1);
  if (existing.length) return markReady(party, deps);

  await deps.publish({ partyId, status: "questions_generating" });
  const cfg = await getQuestionsConfig();
  const spec = await specFor(party);
  const need = party.questionCount + cfg.reserveCount;
  // Nobody seated gets a question they've already seen; if that leaves the bank short, generation fills the gap.
  const seen = await seenBySeated(partyId);
  const fill = await fillQuestions({ spec, providers: deps.providers, want: need, excludeBankIds: seen.map((s) => s.bankId), avoidPayloads: seen.map((s) => s.payload) });

  if (fill.picked.length < need) {
    // Keep the audit trail of the failed attempt (nothing enters the bank or the party set), then fail closed.
    await db.transaction((tx) => persistFill(tx, fill, { partyId, brief: party.brief, spec, banked: false }));
    assertSetFilled(fill.picked.length, need);
  }

  const wentLive = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (!locked || !generatesNow(locked)) return null; // cancelled meanwhile: nothing to seal
    await persistFill(tx, fill, { partyId, brief: party.brief, spec, banked: true });
    await tx.insert(partyQuestions).values(fill.picked.map((q, i) => ({
      partyId,
      idx: i,
      format: q.format,
      payload: q.payload,
      seconds: party.questionSeconds,
      explanation: q.explanation,
      reserve: i >= party.questionCount,
      sourceRef: q.bankId,
      status: party.mode === "curate" ? ("draft" as const) : ("pending" as const),
    }))).onConflictDoNothing();
    // A sealed party that started while we were building isn't ready until the roster re-check has run.
    const live = locked.mode === "sealed" && locked.status === "live";
    await tx.update(parties).set({ specSummary: spec.summary, category: spec.categoryTag, questionsStatus: live ? "generating" : "ready", questionsError: null }).where(eq(parties.id, partyId));
    return live;
  });
  if (wentLive === null) return;

  const bankCount = fill.retrievedCount;
  console.log(`[questions] ${party.title}: ${party.mode === "sealed" ? "sealed" : "drafted"} ${party.questionCount}+${need - party.questionCount} reserve (${bankCount} from bank, ${seen.length} skipped as already seen, ${need - bankCount} generated${spec.sourceScope === "open" ? "" : " from file"}, ${fill.judged.length - fill.accepted.length} rejected)`);
  if (wentLive) await resealForRoster(partyId, deps);
  else await deps.publish({ partyId, status: "questions_ready" });
}

/** The set exists: make sure it's marked ready (running the roster re-check first if the party is live). */
async function markReady(party: Party, deps: GenerateSetDeps) {
  if (party.mode === "sealed" && party.status === "live") return resealForRoster(party.id, deps);
  await db.update(parties).set({ questionsStatus: "ready", questionsError: null }).where(eq(parties.id, party.id));
  await deps.publish({ partyId: party.id, status: "questions_ready" });
}
