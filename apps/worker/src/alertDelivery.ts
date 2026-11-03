/**
 * Delivering admin alerts (raised with adminAlert() in packages/db), from the worker every few seconds,
 * never inline in the request that raised them. Per channel:
 *  - critical: at once, one message per kind, then that kind waits `throttleMinutes` on that channel; what
 *    piles up meanwhile goes in the next message, listed up to `listMax` and then "and N more";
 *  - warning: a digest, at most every `digestMinutes`, every kind together (each listed up to `listMax`);
 *  - info: never sent (the console's list only).
 * A channel's failure is recorded and retried after `retryMinutes`; the other channel isn't held up.
 * Channels are a registry: email (the admin's email provider switch, to ADMIN_ALERT_EMAILS) and an optional
 * Slack-compatible webhook. Adding one is a function returning an AlertChannel.
 *
 * Payments alerts (kinds payments.*: ids, amounts, provider responses) carry full details only on the
 * payments channels (ADMIN_ALERT_PAYMENTS_EMAILS, ADMIN_ALERT_PAYMENTS_WEBHOOK_URL), which carry nothing
 * else. On the general channels they read as their subject and a link to the console.
 */
import {
  lastAlertDelivery, logEmailSend, markAlertsDelivered, recordAlertDelivery, undeliveredAlerts, withAlertDeliveryLock,
  type AdminAlertRow, type Tx, type UndeliveredAlert,
} from "@contestly/db";
import { sendWithFallback, type EmailSender } from "@contestly/email";
import { isPaymentsAlert, type AlertSeverity, type EmailProviderName } from "@contestly/shared";

export interface AlertMessage {
  mode: "immediate" | "digest";
  /** The most severe alert in it. */
  severity: AlertSeverity;
  title: string;
  text: string;
}

/** general: every alert, payments ones as subject and link only. payments: payments alerts only, in full. */
export type AlertAudience = "general" | "payments";

export interface AlertChannel {
  readonly name: string;
  readonly audience: AlertAudience;
  /** Which severities it delivers: critical at once; warning (if listed) in the digest. Never info. */
  readonly severities: readonly ("warning" | "critical")[];
  /** Resolves when delivered; throws otherwise (it's recorded and retried). */
  send(message: AlertMessage): Promise<void>;
}

export interface AlertDeliveryConfig {
  digestMinutes: number;
  throttleMinutes: number;
  listMax: number;
  retryMinutes: number;
  /** The admin console's base URL, for the link a general channel gets in place of a payments alert's details. */
  consoleUrl: string;
}

const int = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer (got "${raw}")`);
  return n;
};

/** Defaults: warnings digested every 30 minutes; one critical message per kind per 10 minutes; 5 listed, then "and N more". */
export const alertDeliveryConfigFromEnv = (env = process.env): AlertDeliveryConfig => ({
  digestMinutes: int(env, "ADMIN_ALERT_DIGEST_MINUTES", 30),
  throttleMinutes: int(env, "ADMIN_ALERT_THROTTLE_MINUTES", 10),
  listMax: int(env, "ADMIN_ALERT_LIST_MAX", 5),
  retryMinutes: int(env, "ADMIN_ALERT_RETRY_MINUTES", 1),
  consoleUrl: (env.ADMIN_CONSOLE_URL?.trim() || `${(env.PUBLIC_WEB_URL ?? "").trim().replace(/\/$/, "")}/admin`).replace(/\/$/, ""),
});

/** How often the worker looks for something to send: "critical at once" means within this. */
export const ALERT_DELIVERY_EVERY_MS = 15_000;

// ---------------------------------------------------------------- channels

/** Email through the admin's provider switch (primary, then the other), one message per recipient, each send logged. */
export function emailChannel(o: {
  /** Its name in the delivery records (default "email"); tests give their own so their clocks start clean. */
  name?: string;
  audience?: AlertAudience;
  recipients: readonly string[];
  senders: Partial<Record<EmailProviderName, EmailSender>>;
  primary: () => Promise<EmailProviderName>;
  log?: typeof logEmailSend;
}): AlertChannel {
  const log = o.log ?? logEmailSend;
  return {
    name: o.name ?? "email",
    audience: o.audience ?? "general",
    severities: ["warning", "critical"],
    async send(m) {
      const primary = await o.primary();
      let delivered = 0;
      for (const to of o.recipients) {
        const outcome = await sendWithFallback(o.senders, primary, { to, subject: m.title, text: m.text, html: `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:pre-wrap">${escapeHtml(m.text)}</pre>` });
        await log({ template: "admin_alert", to, deliveredBy: outcome.deliveredBy, attempts: outcome.attempts });
        if (outcome.deliveredBy) delivered++;
      }
      if (!delivered) throw new Error(`no recipient got it (${o.recipients.length} tried)`);
    },
  };
}

/** A Slack-compatible incoming webhook ({ text }), which most chat tools accept. Critical only unless configured. */
export function webhookChannel(o: { name?: string; audience?: AlertAudience; url: string; severities: AlertChannel["severities"]; fetch?: typeof fetch; timeoutMs?: number }): AlertChannel {
  const post = o.fetch ?? fetch;
  return {
    name: o.name ?? "webhook",
    audience: o.audience ?? "general",
    severities: o.severities,
    async send(m) {
      const res = await post(o.url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `*${m.title}*\n${m.text}` }), signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
      });
      if (!res.ok) throw new Error(`webhook answered ${res.status}`);
    },
  };
}

/**
 * The channels from env: email when ADMIN_ALERT_EMAILS is set; the webhook when ADMIN_ALERT_WEBHOOK_URL is,
 * for critical only unless ADMIN_ALERT_WEBHOOK_SEVERITY=warning (then the digest too). The payments
 * channels likewise from ADMIN_ALERT_PAYMENTS_EMAILS and ADMIN_ALERT_PAYMENTS_WEBHOOK_URL (same severity rule).
 */
export function alertChannelsFromEnv(env: NodeJS.ProcessEnv, email: Omit<Parameters<typeof emailChannel>[0], "recipients">): AlertChannel[] {
  const floor = env.ADMIN_ALERT_WEBHOOK_SEVERITY?.trim() || "critical";
  if (floor !== "critical" && floor !== "warning") throw new Error(`ADMIN_ALERT_WEBHOOK_SEVERITY must be critical or warning (got "${floor}")`);
  const hookSeverities: AlertChannel["severities"] = floor === "warning" ? ["warning", "critical"] : ["critical"];
  const list = (v: string | undefined) => (v ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  const channels: AlertChannel[] = [];
  const add = (audience: AlertAudience, emails: string | undefined, url: string | undefined) => {
    const prefix = audience === "payments" ? "payments_" : "";
    const recipients = list(emails);
    if (recipients.length) channels.push(emailChannel({ ...email, name: `${prefix}email`, audience, recipients }));
    if (url?.trim()) channels.push(webhookChannel({ name: `${prefix}webhook`, audience, url: url.trim(), severities: hookSeverities }));
  };
  add("general", env.ADMIN_ALERT_EMAILS, env.ADMIN_ALERT_WEBHOOK_URL);
  add("payments", env.ADMIN_ALERT_PAYMENTS_EMAILS, env.ADMIN_ALERT_PAYMENTS_WEBHOOK_URL);
  return channels;
}

// ---------------------------------------------------------------- messages

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ACK_LINE = "Acknowledge it in the admin console under Alerts.";

/** How a message shows each alert: in full, or (a payments alert on a general channel) its subject and a console link. */
export interface MessageView {
  listMax: number;
  /** Set on general channels: payments alerts show only their subject and this console link. */
  redactPaymentsTo?: string;
}

function alertLines(a: AdminAlertRow, pending: number, view: MessageView): string[] {
  const times = a.count > 1 ? ` (${pending === a.count ? `×${a.count}` : `${pending} new, ${a.count} in all`})` : "";
  if (view.redactPaymentsTo !== undefined && isPaymentsAlert(a.kind)) {
    return [`• ${a.subject}${times}`, `  Details in the console (payments.view): ${view.redactPaymentsTo}/alerts?kind=${encodeURIComponent(a.kind)}`];
  }
  const ref = a.refType ? `  ${a.refType}: ${a.refId}` : null;
  return [`• ${a.subject}${times}`, ...(ref ? [ref] : []), `  ${JSON.stringify(a.details)}`, `  first ${a.firstSeenAt.toISOString()}, last ${a.lastSeenAt.toISOString()}`];
}

/** Up to `listMax` alerts, then "and N more" (the occurrences not listed). */
function listed(rows: readonly UndeliveredAlert[], view: MessageView): string[] {
  const shown = rows.slice(0, view.listMax);
  const rest = rows.slice(view.listMax).reduce((n, r) => n + r.pending, 0);
  return [...shown.flatMap((r) => alertLines(r.alert, r.pending, view)), ...(rest ? [`…and ${rest} more`] : [])];
}

const occurrences = (rows: readonly UndeliveredAlert[]) => rows.reduce((n, r) => n + r.pending, 0);

/** Critical, one kind: a single alert reads as itself; several read as the kind with a count. */
export function immediateMessage(kind: string, rows: readonly UndeliveredAlert[], view: MessageView): AlertMessage {
  const total = occurrences(rows);
  const title = rows.length === 1 && total === 1 ? `[Contestly] CRITICAL: ${rows[0].alert.subject}` : `[Contestly] CRITICAL: ${kind} (${total} new)`;
  return { mode: "immediate", severity: "critical", title, text: [`${kind}: ${plural(total, "occurrence")}`, "", ...listed(rows, view), "", ACK_LINE].join("\n") };
}

/** Warnings, every kind, grouped by kind (most occurrences first). */
export function digestMessage(rows: readonly UndeliveredAlert[], view: MessageView): AlertMessage {
  const byKind = new Map<string, UndeliveredAlert[]>();
  for (const r of rows) byKind.set(r.alert.kind, [...(byKind.get(r.alert.kind) ?? []), r]);
  const kinds = [...byKind.entries()].sort((a, b) => occurrences(b[1]) - occurrences(a[1]));
  const sections = kinds.flatMap(([kind, kr]) => [`${kind}: ${plural(occurrences(kr), "occurrence")}`, ...listed(kr, view), ""]);
  return { mode: "digest", severity: "warning", title: `[Contestly] Warnings: ${plural(occurrences(rows), "occurrence")} of ${plural(kinds.length, "kind")}`, text: [...sections, ACK_LINE].join("\n") };
}

// ---------------------------------------------------------------- the run

const MIN = 60_000;
/** When a row started waiting on this channel: its first sight, or for a repeat of a delivered alert, its last. */
const pendingSince = (r: UndeliveredAlert) => (r.alreadySent === 0 ? r.alert.firstSeenAt : r.alert.lastSeenAt).getTime();

export interface DeliveryReport { channel: string; mode: "immediate" | "digest"; kind: string | null; alerts: number; occurrences: number; ok: boolean; error?: string }

export interface DeliveryRun {
  now?: Date;
  /** TEST-ONLY: deliver only kinds starting with this, so a test sees its own alerts and nothing else in the database. */
  kindPrefix?: string;
}

/**
 * One pass: for each channel, send what's due. Runs under an advisory lock (one worker at a time); returns
 * what it sent or tried, or null if another worker was already delivering.
 */
export async function deliverAlerts(channels: readonly AlertChannel[], cfg: AlertDeliveryConfig, run: DeliveryRun = {}): Promise<DeliveryReport[] | null> {
  const now = run.now ?? new Date();
  if (!channels.length) return [];
  return withAlertDeliveryLock(async (tx) => {
    const reports: DeliveryReport[] = [];
    for (const channel of channels) reports.push(...await deliverOn(tx, channel, cfg, now, run.kindPrefix));
    return reports;
  });
}

async function deliverOn(tx: Tx, channel: AlertChannel, cfg: AlertDeliveryConfig, now: Date, kindPrefix?: string): Promise<DeliveryReport[]> {
  const reports: DeliveryReport[] = [];
  const t = now.getTime();
  const view: MessageView = { listMax: cfg.listMax, ...(channel.audience === "general" ? { redactPaymentsTo: cfg.consoleUrl } : {}) };
  /** A payments channel carries payments alerts and nothing else. */
  const pending = async (severity: "warning" | "critical") =>
    (await undeliveredAlerts(channel.name, [severity], tx, kindPrefix)).filter((r) => channel.audience === "general" || isPaymentsAlert(r.alert.kind));
  /** Not inside the retry wait after a failed send (unless something sent since). */
  const notRetrying = (last: { ok: Date | null; failed: Date | null }) =>
    !last.failed || (last.ok !== null && last.ok >= last.failed) || t - last.failed.getTime() >= cfg.retryMinutes * MIN;

  const send = async (mode: "immediate" | "digest", kind: string | null, rows: UndeliveredAlert[], message: AlertMessage) => {
    const base = { channel: channel.name, mode, kind, alertIds: rows.map((r) => r.alert.id), occurrences: occurrences(rows), sentAt: now };
    try {
      await channel.send(message);
      await markAlertsDelivered(channel.name, rows.map((r) => ({ id: r.alert.id, deliveredUpTo: r.deliveredUpTo })), tx);
      await recordAlertDelivery({ ...base, ok: true }, tx);
      reports.push({ channel: channel.name, mode, kind, alerts: rows.length, occurrences: base.occurrences, ok: true });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[alerts] ${channel.name} ${mode}${kind ? ` ${kind}` : ""} failed: ${error}`);
      await recordAlertDelivery({ ...base, ok: false, error }, tx);
      reports.push({ channel: channel.name, mode, kind, alerts: rows.length, occurrences: base.occurrences, ok: false, error });
    }
  };

  if (channel.severities.includes("critical")) {
    const critical = await pending("critical");
    const byKind = new Map<string, UndeliveredAlert[]>();
    for (const r of critical) byKind.set(r.alert.kind, [...(byKind.get(r.alert.kind) ?? []), r]);
    for (const [kind, rows] of byKind) {
      const last = await lastAlertDelivery(channel.name, "immediate", kind, tx);
      const throttled = last.ok !== null && t - last.ok.getTime() < cfg.throttleMinutes * MIN;
      if (throttled || !notRetrying(last)) continue;
      await send("immediate", kind, rows, immediateMessage(kind, rows, view));
    }
  }

  if (channel.severities.includes("warning")) {
    const warnings = await pending("warning");
    if (warnings.length) {
      const last = await lastAlertDelivery(channel.name, "digest", null, tx);
      const anchor = Math.max(last.ok?.getTime() ?? 0, Math.min(...warnings.map(pendingSince)));
      if (t - anchor >= cfg.digestMinutes * MIN && notRetrying(last)) await send("digest", null, warnings, digestMessage(warnings, view));
    }
  }
  return reports;
}
