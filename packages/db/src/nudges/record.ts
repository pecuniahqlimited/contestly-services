/**
 * Recording a nudge: one pending row per recipient, written by whatever caused it (pass its transaction, so the
 * nudge commits with its cause). The worker delivers it when it's due (deliver.ts). A `dedupeKey` makes it once
 * per recipient, ever; a `batchKey` (batched kinds) merges it into the recipient's pending one, whose due time
 * keeps at most one going out per the kind's gap. Copy that mentions money is recorded as skipped, never sent.
 */
import { and, desc, eq } from "drizzle-orm";
import { MoneyInNudge, NUDGE_KINDS, renderNudge, type NudgeActor, type NudgeContent, type NudgeData, type NudgeKind, type NudgeKindDef } from "@contestly/shared";
import { db, type Tx } from "../client.js";
import { getNudgeConfig } from "../config.js";
import { nudges } from "../schema.js";

type Conn = Tx | typeof db;

export type NudgeInput<K extends NudgeKind> = {
  userId: string;
  kind: K;
  data: NudgeData[K];
  /** What it's about (a party, a corner), for per-thing caps and withdrawals. */
  ref?: { type: "party" | "corner" | "thread" | "post"; id: string };
  dedupeKey?: string;
  /** Batched kinds only. */
  batchKey?: string;
  /** Who it's about, for batched copy ("Ada and 2 others"). */
  actor?: NudgeActor;
  dueAt?: Date;
};
export type Recorded = "recorded" | "merged" | "duplicate" | "skipped_money";

/** The guarded copy, or the unguarded copy and the fact it mentions money (kept on the skipped record). */
function render<K extends NudgeKind>(kind: K, data: NudgeData[K], actors: NudgeActor[]): { content: NudgeContent; money: boolean } {
  try {
    return { content: renderNudge(kind, data, actors), money: false };
  } catch (e) {
    if (!(e instanceof MoneyInNudge)) throw e;
    return { content: (NUDGE_KINDS[kind] as NudgeKindDef<K>).render(data, actors), money: true };
  }
}

export async function nudge<K extends NudgeKind>(conn: Conn, input: NudgeInput<K>, now = new Date()): Promise<Recorded> {
  const def = NUDGE_KINDS[input.kind] as NudgeKindDef<K>;
  const batchKey = def.batchGap ? input.batchKey : undefined;
  if (batchKey) {
    const merged = await mergeIntoPending(conn, input, batchKey);
    if (merged) return merged;
  }
  const actors = input.actor ? [input.actor] : [];
  const { content, money } = render(input.kind, input.data, actors);
  const dueAt = batchKey ? await batchDueAt(conn, input.userId, batchKey, def, input.dueAt ?? now) : (input.dueAt ?? now);
  const [row] = await conn.insert(nudges).values({
    userId: input.userId, kind: input.kind, category: def.category, refType: input.ref?.type, refId: input.ref?.id,
    data: input.data as Record<string, unknown>, actors, ...content, dedupeKey: input.dedupeKey, batchKey, dueAt,
    ...(money ? { status: "skipped" as const, skipReason: "money" as const, decidedAt: now } : {}),
  }).onConflictDoNothing().returning({ id: nudges.id });
  if (row) return money ? "skipped_money" : "recorded";
  // Lost a race to another pending one of the same batch: merge into it instead.
  if (batchKey) return (await mergeIntoPending(conn, input, batchKey)) ?? "duplicate";
  return "duplicate";
}

/** Adds the actor to the recipient's pending nudge of this batch, re-rendering its copy. Null when there's none. */
async function mergeIntoPending<K extends NudgeKind>(conn: Conn, input: NudgeInput<K>, batchKey: string): Promise<Recorded | null> {
  const [pending] = await conn.select().from(nudges)
    .where(and(eq(nudges.userId, input.userId), eq(nudges.batchKey, batchKey), eq(nudges.status, "pending"))).for("update");
  if (!pending) return null;
  if (!input.actor || pending.actors.some((a) => a.id === input.actor!.id)) return "merged";
  const actors = [...pending.actors, input.actor];
  const { content, money } = render(input.kind, pending.data as NudgeData[K], actors);
  if (!money) await conn.update(nudges).set({ actors, ...content }).where(eq(nudges.id, pending.id));
  else await conn.update(nudges).set({ actors }).where(eq(nudges.id, pending.id));
  return "merged";
}

/** A new batch goes out now, unless one of the same batch went out less than the kind's gap ago: then at the end of the gap. */
async function batchDueAt(conn: Conn, userId: string, batchKey: string, def: NudgeKindDef<NudgeKind>, at: Date): Promise<Date> {
  const gapSeconds = (await getNudgeConfig(conn))[def.batchGap!] as number;
  const [last] = await conn.select({ at: nudges.decidedAt }).from(nudges)
    .where(and(eq(nudges.userId, userId), eq(nudges.batchKey, batchKey), eq(nudges.status, "sent")))
    .orderBy(desc(nudges.decidedAt)).limit(1);
  const next = last?.at ? last.at.getTime() + gapSeconds * 1000 : 0;
  return new Date(Math.max(at.getTime(), next));
}

/** Pending nudges about this thing for these people (or everyone) are withdrawn: a party they left. */
export async function withdrawNudges(conn: Conn, refId: string, userId?: string, now = new Date()): Promise<number> {
  const rows = await conn.update(nudges).set({ status: "withdrawn", decidedAt: now })
    .where(and(eq(nudges.refId, refId), eq(nudges.status, "pending"), userId ? eq(nudges.userId, userId) : undefined)).returning({ id: nudges.id });
  return rows.length;
}
