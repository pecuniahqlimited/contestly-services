/**
 * reseal_for_roster: the start-time re-check of a sealed set against the final roster. Only the
 * questions someone seated has already seen are touched (a player who joined after the set was
 * generated may have played one elsewhere since). Each is replaced in place from, in order: an
 * unused reserve nobody has seen, a bank question nobody has seen, a small generated top-up. Seen
 * reserves are dropped so a void can never promote them. Every swap is logged; then the set is
 * marked ready and the room starts.
 *
 * The worker only enqueues this when its own check found something to swap, so a clean start
 * never waits on it. Fail closed: if the top-up can't fill the gap the job throws, and the final
 * failure cancels and refunds the live party (index.ts).
 */
import { and, asc, eq } from "drizzle-orm";
import { db, parties, partyQuestions, partyQuestionEvents, seenBySeated, seenInSet, type PartyQuestion } from "@contestly/db";
import type { Providers } from "../providers/types.js";
import { fillQuestions, persistFill } from "./fill.js";
import { assertSetFilled } from "./gate.js";
import { specFor } from "./partySpec.js";

export interface ResealDeps {
  providers: Providers;
  publish: (ev: { partyId: string; status: string }) => Promise<unknown>;
}

type Content = Pick<PartyQuestion, "format" | "payload" | "explanation" | "sourceRef">;

export async function resealForRoster(partyId: string, deps: ResealDeps): Promise<void> {
  const [party] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!party || party.mode !== "sealed" || party.status !== "live") return;

  const seenRows = await seenInSet(partyId);
  const seenSlots = seenRows.filter((q) => !q.reserve).sort((a, b) => a.idx - b.idx);
  const seenReserves = seenRows.filter((q) => q.reserve);
  const seenIds = new Set(seenRows.map((q) => q.id));

  const all = await db.select().from(partyQuestions).where(eq(partyQuestions.partyId, partyId)).orderBy(asc(partyQuestions.idx));
  const freshReserves = all.filter((q) => q.reserve && q.status === "pending" && !seenIds.has(q.id));
  const fromReserves = seenSlots.slice(0, freshReserves.length).map((slot, i) => ({ slot, reserve: freshReserves[i] }));
  const stillNeeded = seenSlots.slice(fromReserves.length);

  // Bank, then a top-up, for whatever the reserves couldn't cover. Nothing seen, nothing already in this set.
  const spec = stillNeeded.length ? await specFor(party) : null;
  const seen = stillNeeded.length ? await seenBySeated(partyId) : [];
  const fill = spec
    ? await fillQuestions({
        spec, providers: deps.providers, want: stillNeeded.length,
        excludeBankIds: [...seen.map((s) => s.bankId), ...all.map((q) => q.sourceRef!).filter(Boolean)],
        avoidPayloads: [...seen.map((s) => s.payload), ...all.map((q) => q.payload)],
      })
    : null;
  if (spec && fill && fill.picked.length < stillNeeded.length) {
    await db.transaction((tx) => persistFill(tx, fill, { partyId, brief: party.brief, spec, banked: false }));
    assertSetFilled(fill.picked.length, stillNeeded.length);
  }

  await db.transaction(async (tx) => {
    const replace = async (slot: PartyQuestion, next: Content, source: "reserve" | "bank" | "generated") => {
      await tx.update(partyQuestions).set({ format: next.format, payload: next.payload, explanation: next.explanation, sourceRef: next.sourceRef }).where(eq(partyQuestions.id, slot.id));
      await tx.insert(partyQuestionEvents).values({ partyId, questionId: slot.id, kind: "replace", detail: { reason: "seen_by_roster", source, replacedBankId: slot.sourceRef, newBankId: next.sourceRef } });
    };
    for (const { slot, reserve } of fromReserves) {
      await replace(slot, reserve, "reserve");
      await tx.update(partyQuestions).set({ status: "voided" }).where(eq(partyQuestions.id, reserve.id)); // used up
    }
    if (spec && fill) {
      await persistFill(tx, fill, { partyId, brief: party.brief, spec, banked: true });
      for (const [i, slot] of stillNeeded.entries()) {
        const p = fill.picked[i];
        await replace(slot, { format: p.format, payload: p.payload, explanation: p.explanation, sourceRef: p.bankId }, p.from);
      }
    }
    for (const r of seenReserves) {
      await tx.update(partyQuestions).set({ status: "voided" }).where(and(eq(partyQuestions.id, r.id), eq(partyQuestions.reserve, true)));
      await tx.insert(partyQuestionEvents).values({ partyId, questionId: r.id, kind: "replace", detail: { reason: "seen_by_roster", source: "dropped_reserve", replacedBankId: r.sourceRef } });
    }
    await tx.update(parties).set({ questionsStatus: "ready", questionsError: null }).where(eq(parties.id, partyId));
  });

  await deps.publish({ partyId, status: "questions_ready" });
  console.log(`[questions] ${party.title}: start re-check swapped ${seenSlots.length} question(s) a seated player had seen (${fromReserves.length} from reserves, ${stillNeeded.length} from bank/top-up), dropped ${seenReserves.length} seen reserve(s)`);
}
