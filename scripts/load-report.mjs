#!/usr/bin/env node
/**
 * Merges load-test shard reports (scripts/load-party.ts) into one summary, from the raw samples so percentiles
 * are exact. Plain JavaScript with no dependencies, so it runs anywhere Node does.
 *
 *   node scripts/load-report.mjs load-report-*.json            Markdown summary on stdout
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SAMPLE_LABELS = {
  createMs: "Create a party (API)",
  generateMs: "Party created → questions ready",
  joinMs: "Join a party (API)",
  connectMs: "Connect to the party room",
  questionLagMs: "Question opened → reaches a player",
  fanoutSpreadMs: "Same question: first → last player (fan-out)",
  revealLagMs: "Question closes → reveal reaches a player",
  chatAckMs: "Chat line sent → acknowledged",
};

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);

/** One summary from any number of shard reports of the same run. */
export function summarise(reports) {
  const counts = {};
  const errors = {};
  const samples = {};
  for (const r of reports) {
    for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.errors)) errors[k] = (errors[k] ?? 0) + v;
    // A loop, not push(...v): a shard can hold more samples than a call takes arguments.
    for (const [k, v] of Object.entries(r.samples)) for (const x of v) (samples[k] ??= []).push(x);
  }
  const stats = {};
  for (const [k, values] of Object.entries(samples)) {
    const sorted = values.sort((a, b) => a - b);
    stats[k] = { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.length ? sorted[sorted.length - 1] : null };
  }
  const first = reports[0] ?? {};
  return { run: first.run, api: first.api, startsAt: first.startsAt, settings: first.settings, shards: reports.length, counts, errors, stats };
}

const ms = (v) => (v === null || v === undefined ? "–" : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "–");

/** The summary as Markdown: fits a terminal and GitHub's job summary alike. */
export function formatSummary(s) {
  const c = s.counts;
  const st = s.settings ?? {};
  const players = c.players ?? 0;
  const expectedQuestions = (c.connected ?? 0) * (st.questions ?? 0);
  const lines = [
    `## Load test ${s.run ?? ""}`,
    "",
    `${st.parties} parties × ${st.players} players = **${(st.parties ?? 0) * (st.players ?? 0)} players**, ${st.questions} questions of ${st.seconds} s, from ${s.shards} machine(s), against ${s.api}.`,
    "",
    "| | count | of | |",
    "|---|---:|---:|---:|",
    `| Parties created | ${c.partiesCreated ?? 0} | ${st.parties} | ${pct(c.partiesCreated, st.parties)} |`,
    `| Parties with questions ready in time | ${c.partiesReady ?? 0} | ${c.partiesCreated ?? 0} | ${pct(c.partiesReady, c.partiesCreated)} |`,
    `| Players seated (host + joins) | ${(c.joined ?? 0) + (c.partiesCreated ?? 0)} | ${players} | ${pct((c.joined ?? 0) + (c.partiesCreated ?? 0), players)} |`,
    `| Players connected to their room | ${c.connected ?? 0} | ${players} | ${pct(c.connected, players)} |`,
    `| Parties split across several rooms (must be 0) | ${c.partiesSplit ?? 0} | ${c.partiesCreated ?? 0} | ${pct(c.partiesSplit, c.partiesCreated)} |`,
    `| Questions received | ${c.questionsReceived ?? 0} | ${expectedQuestions} | ${pct(c.questionsReceived, expectedQuestions)} |`,
    `| Players who saw the final standings | ${c.finalsReceived ?? 0} | ${c.connected ?? 0} | ${pct(c.finalsReceived, c.connected)} |`,
    `| Answers sent | ${c.answersSent ?? 0} | | |`,
    `| Chat lines acknowledged | ${c.chatsAcked ?? 0} | ${c.chatsSent ?? 0} | ${pct(c.chatsAcked, c.chatsSent)} |`,
    `| Unexpected disconnects | ${c.unexpectedDisconnects ?? 0} | | |`,
    "",
    "| Timing | samples | p50 | p95 | p99 | max |",
    "|---|---:|---:|---:|---:|---:|",
    ...Object.entries(SAMPLE_LABELS).map(([k, label]) => {
      const x = s.stats[k] ?? { n: 0 };
      return `| ${label} | ${x.n} | ${ms(x.p50)} | ${ms(x.p95)} | ${ms(x.p99)} | ${ms(x.max)} |`;
    }),
    "",
    "Lags against the server's clock include the network and any clock difference between machines (usually a few ms with NTP).",
  ];
  const errs = Object.entries(s.errors).sort((a, b) => b[1] - a[1]);
  lines.push("", errs.length ? "| Error | count |\n|---|---:|\n" + errs.map(([k, v]) => `| ${k.replace(/\|/g, "/")} | ${v} |`).join("\n") : "No errors.");
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: node scripts/load-report.mjs <report.json>…");
    process.exit(2);
  }
  console.log(formatSummary(summarise(files.map((f) => JSON.parse(readFileSync(f, "utf8"))))));
}
