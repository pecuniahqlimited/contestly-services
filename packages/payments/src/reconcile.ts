/**
 * Nightly reconciliation, per provider and Lagos day: our top-ups and withdrawals against the provider's own
 * lists. Every difference becomes a row for an admin (missing on our side, missing on theirs, amount differs,
 * status differs). Nothing is fixed here; a confirmed missed top-up is replayed by an admin through the normal
 * verify path. A reversed withdrawal the provider lists as paid is asked about at once (checkPayout), which
 * freezes the person's withdrawals if the provider confirms it.
 */
import { and, eq, gte, lt } from "drizzle-orm";
import { db, paymentReconItems, paymentReconRuns, payouts, topups, adminAlert } from "@contestly/db";
import { lagosDayRange, ONCE_PER_THING_SECONDS } from "./common.js";
import { providerNamed } from "./providers/index.js";
import { checkPayout } from "./payouts.js";
import type { ProviderRecord } from "./types.js";

type Kind = "missing_ours" | "missing_theirs" | "amount_differs" | "status_differs";
interface Ours { reference: string; amountKobo: number; status: string }
interface Item { object: "topup" | "payout"; kind: Kind; reference: string; ours: Ours | null; theirs: ProviderRecord | null }

/** Our statuses that mean money moved (top-up credited, transfer sent) vs. ones that mean it didn't. */
const MOVED = { topup: ["succeeded"], payout: ["succeeded"] } as const;
const NOT_MOVED = { topup: ["failed", "expired", "pending"], payout: ["failed", "rejected"] } as const;
/** Sent to the provider (so it should know it): every payout status except the ones never sent. */
const SENT = ["submitted", "unknown", "succeeded", "failed"];

export function compare(object: "topup" | "payout", ours: Ours[], theirs: ProviderRecord[]): Item[] {
  const items: Item[] = [];
  const theirsBy = new Map(theirs.map((t) => [t.reference, t]));
  const oursBy = new Map(ours.map((o) => [o.reference, o]));
  for (const t of theirs) if (!oursBy.has(t.reference) && t.status === "success") items.push({ object, kind: "missing_ours", reference: t.reference, ours: null, theirs: t });
  for (const o of ours) {
    const t = theirsBy.get(o.reference);
    const expected = object === "payout" ? SENT.includes(o.status) : (MOVED.topup as readonly string[]).includes(o.status);
    if (!t) { if (expected) items.push({ object, kind: "missing_theirs", reference: o.reference, ours: o, theirs: null }); continue; }
    if (t.status === "success" && t.amountKobo !== o.amountKobo) items.push({ object, kind: "amount_differs", reference: o.reference, ours: o, theirs: t });
    const weMoved = (MOVED[object] as readonly string[]).includes(o.status);
    const weDidNot = (NOT_MOVED[object] as readonly string[]).includes(o.status);
    if ((t.status === "success" && weDidNot) || (weMoved && t.status !== "success") || (object === "payout" && o.status === "unknown" && (t.status === "success" || t.status === "failed"))) {
      items.push({ object, kind: "status_differs", reference: o.reference, ours: o, theirs: t });
    }
  }
  return items;
}

export async function reconcileDay(providerName: string, day: string) {
  const range = lagosDayRange(day);
  const provider = providerNamed(providerName);
  const [run] = await db.insert(paymentReconRuns).values({ provider: providerName, day }).returning();
  try {
    const items: Item[] = [];
    if (provider.collection) {
      const ours = await db.select({ reference: topups.reference, amountKobo: topups.amountKobo, status: topups.status }).from(topups)
        .where(and(eq(topups.provider, providerName), gte(topups.createdAt, range.from), lt(topups.createdAt, range.to)));
      items.push(...compare("topup", ours, await provider.collection.listTopups(range)));
    }
    if (provider.payout) {
      // The sent amount is what the provider knows.
      const ours = await db.select({ reference: payouts.reference, amountKobo: payouts.sentKobo, status: payouts.status }).from(payouts)
        .where(and(eq(payouts.provider, providerName), gte(payouts.createdAt, range.from), lt(payouts.createdAt, range.to)));
      items.push(...compare("payout", ours, await provider.payout.listTransfers(range)));
    }
    if (items.length) await db.insert(paymentReconItems).values(items.map((i) => ({ runId: run.id, provider: providerName, object: i.object, kind: i.kind, reference: i.reference, ours: i.ours, theirs: i.theirs })));
    const counts = Object.fromEntries((["missing_ours", "missing_theirs", "amount_differs", "status_differs"] as const).map((k) => [k, items.filter((i) => i.kind === k).length]));
    await db.update(paymentReconRuns).set({ finishedAt: new Date(), counts }).where(eq(paymentReconRuns.id, run.id));
    if (items.length) await adminAlert({ severity: "warning", kind: "payments.reconciliation_differences", subject: "Reconciliation found differences", dedupeKey: `recon:${providerName}:${day}:${run.id}`, refType: "recon_run", refId: run.id, details: { provider: providerName, day, counts }, dedupeWindowSeconds: ONCE_PER_THING_SECONDS });
    // A withdrawal we gave back that the provider lists as paid: ask the provider now, so a confirmed
    // contradiction freezes the person's withdrawals tonight rather than whenever a webhook comes.
    for (const i of items) {
      if (i.object !== "payout" || i.kind !== "status_differs" || i.theirs?.status !== "success" || !["failed", "rejected"].includes(i.ours?.status ?? "")) continue;
      const [p] = await db.select({ id: payouts.id }).from(payouts).where(and(eq(payouts.provider, providerName), eq(payouts.reference, i.reference)));
      if (p) await checkPayout(p.id, "check");
    }
    return { runId: run.id, items };
  } catch (e) {
    await db.update(paymentReconRuns).set({ finishedAt: new Date(), error: (e as Error).message }).where(eq(paymentReconRuns.id, run.id));
    await adminAlert({ severity: "warning", kind: "payments.reconciliation_failed", subject: "Reconciliation failed", dedupeKey: `recon_failed:${providerName}:${day}`, refType: "recon_run", refId: run.id, details: { error: (e as Error).message } });
    throw e;
  }
}
