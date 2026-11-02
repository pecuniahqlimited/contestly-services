/**
 * Changing payments controls (ADR 0013). Tightening applies at once with one admin: pausing, lowering a
 * limit or threshold. Anything that loosens a control waits for a second admin with payments.config:
 * raising a limit or threshold, lowering a minimum or a safety delay, switching a provider, un-pausing. A
 * field not listed as tightening in one direction counts as loosening whichever way it moves. The config (or
 * settings) row and the admin log entry are written in one transaction, under one lock, so two changes can't
 * interleave; a confirm applies only if nothing changed since it was asked.
 */
import { desc, eq, sql } from "drizzle-orm";
import { db, getPaymentsConfig, paymentConfigChanges, recordAdminAction, setPaymentsConfig, type PaymentConfigChange, type Tx } from "@contestly/db";
import { CHANGED_SINCE_REQUEST, SECOND_ADMIN_REQUIRED, paymentsConfigSchema, type PaymentsConfig, type PaymentSettingsView } from "@contestly/shared";
import { paymentsError } from "./common.js";
import { assertProvidersConfigured, currentSettings, saveSettings, type SettingsChange } from "./settings.js";

/** Config fields where a higher number lets more money through (or with less scrutiny). */
const LOOSER_WHEN_HIGHER = new Set([
  "topup.maxKobo", "topup.dailyCapKobo", "payout.maxKobo", "payout.dailyAmountKobo", "payout.dailyCount", "payout.approvalThresholdKobo",
  "payout.userDailyApprovalCeilingKobo", "finalize.secondAdminThresholdKobo", "velocity.payoutsPerHour", "velocity.userPayoutsPerHour", "checks.unknownAlertAfterMinutes",
]);
/** Config fields where a lower number is looser: minimums and the delays that keep a transfer from being paid twice. */
const LOOSER_WHEN_LOWER = new Set(["topup.minKobo", "payout.minKobo", "checks.resendAfterNotFoundSeconds", "finalize.quietAfterSendMinutes"]);

function leaves(o: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (o && typeof o === "object" && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) for (const [p, x] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(p, x);
  } else out.set(prefix, o);
  return out;
}

/** Which config fields a change loosens. Empty: it only tightens (or changes nothing). */
export function configLoosens(before: PaymentsConfig, after: PaymentsConfig): string[] {
  const a = leaves(before), b = leaves(after);
  const loosened: string[] = [];
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    const was = a.get(path), now = b.get(path);
    if (was === now) continue;
    const higher = typeof was === "number" && typeof now === "number" && now > was;
    const lower = typeof was === "number" && typeof now === "number" && now < was;
    if (LOOSER_WHEN_HIGHER.has(path) && lower) continue;
    if (LOOSER_WHEN_LOWER.has(path) && higher) continue;
    loosened.push(path);
  }
  return loosened.sort();
}

type Settings = Pick<SettingsChange, "collections" | "payouts" | "topupsPaused" | "payoutsPaused">;
/** Which settings a change loosens: a provider switched, or a kill switch turned off. Pausing is tightening. */
export function settingsLoosens(before: Settings, after: Settings): string[] {
  const out: string[] = [];
  if (before.collections !== after.collections) out.push("collections");
  if (before.payouts !== after.payouts) out.push("payouts");
  if (before.topupsPaused && !after.topupsPaused) out.push("topups_unpaused");
  if (before.payoutsPaused && !after.payoutsPaused) out.push("payouts_unpaused");
  return out;
}

const iso = (d: Date) => d.toISOString();
export const configChangeView = (c: PaymentConfigChange) => ({
  id: c.id, kind: c.kind, loosens: c.loosens, reason: c.reason, status: c.status, requestedBy: c.requestedByUserId, confirmedBy: c.confirmedByUserId,
  before: c.before, proposed: c.proposed, createdAt: iso(c.createdAt),
});

/** Serialises every payments config and settings change. */
const lockControls = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('payments_controls'))`);
const settingsOf = (s: PaymentSettingsView): Settings => ({ collections: s.collections, payouts: s.payouts, topupsPaused: s.topupsPaused, payoutsPaused: s.payoutsPaused });
/** Equal as values (stored jsonb comes back with its keys in another order). */
const same = (x: unknown, y: unknown) => {
  const a = leaves(x), b = leaves(y);
  return a.size === b.size && [...a].every(([k, v]) => b.has(k) && b.get(k) === v);
};

type Kind = "config" | "settings";
async function current(tx: Tx, kind: Kind) {
  return kind === "config" ? await getPaymentsConfig(tx) : settingsOf(await currentSettings(tx));
}
async function apply(tx: Tx, kind: Kind, proposed: unknown, reason: string, adminUserId: string) {
  if (kind === "config") await setPaymentsConfig(proposed, tx);
  else await saveSettings(tx, { ...(proposed as Settings), reason }, adminUserId);
}

export type ControlChangeResult = { applied: true; change: null } | { applied: false; change: ReturnType<typeof configChangeView> };

/** An admin's change: applied now if it only tightens, otherwise left for a second admin. Logged either way. */
export async function proposeControlChange(adminUserId: string, kind: Kind, proposed: PaymentsConfig | Settings, reason: string): Promise<ControlChangeResult> {
  const parsed = kind === "config" ? paymentsConfigSchema.parse(proposed) : settingsOf(proposed as PaymentSettingsView);
  if (kind === "settings") assertProvidersConfigured(parsed as Settings);
  return db.transaction(async (tx) => {
    await lockControls(tx);
    const before = await current(tx, kind);
    const loosens = kind === "config" ? configLoosens(before as PaymentsConfig, parsed as PaymentsConfig) : settingsLoosens(before as Settings, parsed as Settings);
    const action = kind === "config" ? "config.payments" : "config.payments_settings";
    if (!loosens.length) {
      await apply(tx, kind, parsed, reason, adminUserId);
      await recordAdminAction(tx, { adminUserId, action, targetType: "config", targetId: kind === "config" ? "payments" : "payments_settings", reason, before, after: parsed });
      return { applied: true, change: null };
    }
    const [open] = await tx.select().from(paymentConfigChanges).where(sql`${paymentConfigChanges.kind} = ${kind} and ${paymentConfigChanges.status} = 'awaiting_second_admin'`);
    if (open) throw paymentsError(409, "change_pending", { changeId: open.id });
    const [row] = await tx.insert(paymentConfigChanges).values({ kind, before, proposed: parsed, loosens, reason, status: "awaiting_second_admin", requestedByUserId: adminUserId }).returning();
    await recordAdminAction(tx, { adminUserId, action: `${action}_requested`, targetType: "config", targetId: row.id, reason, before, after: { proposed: parsed, loosens } });
    return { applied: false, change: configChangeView(row) };
  });
}

/** A second admin confirms a loosening change. If the config moved since it was asked, it's superseded, not applied. */
export async function confirmControlChange(adminUserId: string, changeId: string) {
  return db.transaction(async (tx) => {
    await lockControls(tx);
    const [c] = await tx.select().from(paymentConfigChanges).where(eq(paymentConfigChanges.id, changeId)).for("update");
    if (!c) throw paymentsError(404, "not_found");
    if (c.status !== "awaiting_second_admin") throw paymentsError(409, "change_not_pending", { status: c.status });
    if (c.requestedByUserId === adminUserId) throw paymentsError(403, SECOND_ADMIN_REQUIRED);
    const now = await current(tx, c.kind);
    if (!same(now, c.before)) {
      // Asked against something that's no longer current: never applied over a newer change. Ask again.
      const [gone] = await tx.update(paymentConfigChanges).set({ status: "superseded" }).where(eq(paymentConfigChanges.id, c.id)).returning();
      await recordAdminAction(tx, { adminUserId, action: "config.payments_change_superseded", targetType: "config", targetId: c.id, reason: c.reason, before: c.before, after: { current: now, why: CHANGED_SINCE_REQUEST } });
      return configChangeView(gone);
    }
    await apply(tx, c.kind, c.proposed, c.reason, adminUserId);
    const [done] = await tx.update(paymentConfigChanges).set({ status: "applied", confirmedByUserId: adminUserId, appliedAt: new Date() }).where(eq(paymentConfigChanges.id, c.id)).returning();
    await recordAdminAction(tx, {
      adminUserId, action: c.kind === "config" ? "config.payments" : "config.payments_settings", targetType: "config", targetId: c.kind === "config" ? "payments" : "payments_settings",
      reason: c.reason, before: c.before, after: { applied: c.proposed, loosens: c.loosens, requestedBy: c.requestedByUserId, changeId: c.id },
    });
    return configChangeView(done);
  });
}

export async function listControlChanges(limit: number) {
  return (await db.select().from(paymentConfigChanges).orderBy(desc(paymentConfigChanges.createdAt)).limit(limit)).map(configChangeView);
}
