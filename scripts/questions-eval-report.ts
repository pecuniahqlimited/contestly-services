/**
 * The eval's report: pass rates at each gate step, latency and cost per step and per question, then every
 * question as a card (answer, distractors, verdict, sources, safety, dedupe). One self-contained HTML page
 * that follows the reader's light or dark setting, plus a plain-text summary for the terminal.
 */
import type { QuestionFormat } from "@contestly/shared";
import type { EvalQuestion, EvalResult } from "./questions-eval.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");
const usd = (micros: number, digits = 4) => `$${(micros / 1_000_000).toFixed(digits)}`;
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

interface Funnel { drafted: number; valid: number; verified: number; unique: number; safe: number; accepted: number }

function funnel(qs: EvalQuestion[]): Funnel {
  const valid = qs.filter((q) => q.outcome !== "rejected_invalid");
  const verified = valid.filter((q) => q.outcome !== "rejected_verify");
  const unique = verified.filter((q) => q.outcome !== "rejected_dedupe");
  const safe = unique.filter((q) => q.outcome !== "rejected_safety");
  return { drafted: qs.length, valid: valid.length, verified: verified.length, unique: unique.length, safe: safe.length, accepted: safe.length };
}

const groupBy = <T>(xs: T[], key: (x: T) => string) => xs.reduce((m, x) => m.set(key(x), [...(m.get(key(x)) ?? []), x]), new Map<string, T[]>());

export function renderReport(r: EvalResult): { html: string; summary: string } {
  const f = funnel(r.questions);
  const ok = r.calls.filter((c) => c.outcome === "ok");
  const totalMicros = r.calls.reduce((a, c) => a + c.costMicros, 0);
  const steps = [...groupBy(r.calls, (c) => c.step)].map(([step, calls]) => {
    const lat = calls.filter((c) => c.outcome === "ok").map((c) => c.latencyMs);
    return {
      step, calls: calls.length, failed: calls.filter((c) => c.outcome !== "ok").length,
      models: [...new Set(calls.map((c) => c.model))].join(", "),
      p50: quantile(lat, 0.5), p95: quantile(lat, 0.95), costMicros: calls.reduce((a, c) => a + c.costMicros, 0),
      inputTokens: calls.reduce((a, c) => a + c.inputTokens, 0), outputTokens: calls.reduce((a, c) => a + c.outputTokens, 0),
      searches: calls.reduce((a, c) => a + c.searchQueries, 0),
      failures: [...groupBy(calls.filter((c) => c.outcome !== "ok"), (c) => c.outcome)].map(([k, v]) => `${k} ×${v.length}`).join(", "),
    };
  });
  const verdicts = [...groupBy(r.questions.filter((q) => q.verify), (q) => q.verify!.verdict)].map(([k, v]) => `${k} ${v.length}`).join(" · ");
  const wallMs = Date.parse(r.finishedAt) - Date.parse(r.startedAt);

  const summary = [
    `Questions eval ${r.startedAt.slice(0, 16).replace("T", " ")} UTC — ${r.sets.length} sets, ${f.drafted} drafts, ${f.accepted} accepted (${pct(f.accepted, f.drafted)})`,
    `  shape valid ${pct(f.valid, f.drafted)} · verification ${pct(f.verified, f.valid)} (${verdicts}) · dedupe ${pct(f.unique, f.verified)} · safety ${pct(f.safe, f.unique)}`,
    ...steps.map((s) => `  ${s.step.padEnd(10)} ${String(s.calls).padStart(4)} calls ${s.failed ? `(${s.failures}) ` : ""}p50 ${(s.p50 / 1000).toFixed(1)}s p95 ${(s.p95 / 1000).toFixed(1)}s ${usd(s.costMicros, 3)}`),
    `  cost ${usd(totalMicros, 2)} total · ${usd(f.drafted ? totalMicros / f.drafted : 0)} per draft · ${usd(f.accepted ? totalMicros / f.accepted : 0)} per accepted question · ${(wallMs / 60000).toFixed(1)} min`,
  ].join("\n");

  const breakdown = (title: string, key: (q: EvalQuestion) => string) => {
    const rows = [...groupBy(r.questions, key)].map(([k, qs]) => { const g = funnel(qs); return `<tr><td>${esc(k)}</td><td>${g.drafted}</td><td>${pct(g.valid, g.drafted)}</td><td>${pct(g.verified, g.valid)}</td><td>${pct(g.unique, g.verified)}</td><td>${pct(g.safe, g.unique)}</td><td><b>${g.accepted}</b> (${pct(g.accepted, g.drafted)})</td></tr>`; }).join("");
    return `<h3>${esc(title)}</h3><table><thead><tr><th></th><th>Drafted</th><th>Valid</th><th>Verified</th><th>Unique</th><th>Safe</th><th>Accepted</th></tr></thead><tbody>${rows}</tbody></table>`;
  };

  const stepRows = steps.map((s) => `<tr><td>${esc(s.step)}</td><td>${esc(s.models)}</td><td>${s.calls}</td><td>${s.failed ? `<span class="bad">${esc(s.failures)}</span>` : "0"}</td><td>${(s.p50 / 1000).toFixed(1)} s</td><td>${(s.p95 / 1000).toFixed(1)} s</td><td>${s.inputTokens.toLocaleString()} / ${s.outputTokens.toLocaleString()}</td><td>${s.searches || "–"}</td><td>${usd(s.costMicros, 3)}</td></tr>`).join("");
  const setRows = r.sets.map((s) => `<tr><td>${esc(s.id)}</td><td>${s.skipped ? `<span class="bad">${esc(s.skipped)}</span>` : `${s.accepted}/${s.wanted}`}</td><td>${s.drafted}</td><td>${(s.ms / 1000).toFixed(0)} s</td><td>${s.unavailable.length ? `<span class="bad">${esc(s.unavailable.join(", "))}</span>` : ""}</td></tr>`).join("");

  const cards = [...groupBy(r.questions, (q) => q.set)].map(([set, qs]) => `<section><h2>${esc(set)}</h2>${qs.map(card).join("")}</section>`).join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Questions eval ${esc(r.startedAt.slice(0, 10))}</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1b1d21;--muted:#5d6470;--line:#e2e3e0;--good:#11724a;--goodbg:#e6f5ee;--bad:#b3261e;--badbg:#fbeceb;--warn:#8a5a00;--warnbg:#fdf3dc;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#121316;--card:#1b1d22;--ink:#ecedef;--muted:#a1a7b3;--line:#2c2f36;--good:#5fd39b;--goodbg:#13281f;--bad:#ff8a80;--badbg:#2e1716;--warn:#f1c35c;--warnbg:#2c2410;--accent:#8fb0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 12px;padding-top:8px;border-top:1px solid var(--line)}h3{font-size:15px;margin:20px 0 8px}
.meta{color:var(--muted);font-size:13px}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.kpi b{display:block;font-size:22px}.kpi span{color:var(--muted);font-size:12px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px;font-size:13px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.q{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.q header{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}.tag{font-size:11px;padding:2px 8px;border-radius:99px;background:var(--bg);color:var(--muted);border:1px solid var(--line)}
.out{font-weight:600}.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.tag.good{background:var(--goodbg);border-color:transparent}.tag.bad{background:var(--badbg);border-color:transparent}.tag.warn{background:var(--warnbg);border-color:transparent}
.qt{font-size:16px;font-weight:600;margin:4px 0 8px}ul.opts{margin:0 0 8px;padding-left:20px}ul.opts li.right{color:var(--good);font-weight:600}
.img{font-size:13px;color:var(--muted);margin-bottom:6px}.kv{display:grid;grid-template-columns:110px 1fr;gap:2px 10px;font-size:13px}.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}
a{color:var(--accent)}
</style></head><body><main>
<h1>Question engine eval</h1>
<p class="meta">${esc(r.startedAt.replace("T", " ").slice(0, 16))} UTC · ${(wallMs / 60000).toFixed(1)} min · profile ${esc(r.providers.profile ?? "paid")} · generate ${esc(r.providers.generator)} · verify ${esc(r.providers.verifier)} · safety ${esc(r.providers.safety)} · embed ${esc(r.providers.embedModel)}${r.providers.profile === "free" ? " · cost $0 (free tier; correct verdicts are checked without sources)" : ""}</p>
<div class="kpis">
<div class="kpi"><b>${f.accepted} / ${f.drafted}</b><span>accepted / drafted (${pct(f.accepted, f.drafted)})</span></div>
<div class="kpi"><b>${pct(f.verified, f.valid)}</b><span>verification pass</span></div>
<div class="kpi"><b>${pct(f.unique, f.verified)}</b><span>dedupe pass</span></div>
<div class="kpi"><b>${pct(f.safe, f.unique)}</b><span>safety pass</span></div>
<div class="kpi"><b>${usd(totalMicros, 2)}</b><span>total cost (${ok.length}/${r.calls.length} calls ok)</span></div>
<div class="kpi"><b>${usd(f.accepted ? totalMicros / f.accepted : 0, 3)}</b><span>per accepted question (${usd(f.drafted ? totalMicros / f.drafted : 0, 3)} per draft)</span></div>
</div>
<p class="meta">Pass rates follow the gate's order: shape valid → verified correct → not a duplicate → safe → accepted. Verdicts: ${esc(verdicts)}.</p>
<h3>Steps</h3><div class="scroll"><table><thead><tr><th>Step</th><th>Model</th><th>Calls</th><th>Failed</th><th>p50</th><th>p95</th><th>Tokens in / out</th><th>Searches</th><th>Cost</th></tr></thead><tbody>${stepRows}</tbody></table></div>
<div class="scroll">${breakdown("By lane", (q) => q.lane)}</div>
<div class="scroll">${breakdown("By difficulty", (q) => q.difficultyBand)}</div>
<div class="scroll">${breakdown("By format", (q) => q.draft.format)}</div>
<h3>Sets</h3><div class="scroll"><table><thead><tr><th>Set</th><th>Accepted</th><th>Drafted</th><th>Time</th><th>Unavailable</th></tr></thead><tbody>${setRows}</tbody></table></div>
${cards}
</main></body></html>`;
  return { html, summary };
}

const OUTCOME: Record<string, [string, string]> = {
  accepted: ["Accepted", "good"], rejected_invalid: ["Invalid shape", "bad"], rejected_verify: ["Failed verification", "bad"],
  rejected_dedupe: ["Duplicate", "warn"], rejected_safety: ["Failed safety", "bad"],
};

function options(format: QuestionFormat, p: Record<string, unknown>): string {
  const list = (xs: unknown) => (Array.isArray(xs) ? (xs as string[]) : []);
  if (format === "pick_one" || format === "picture") return `<ul class="opts">${list(p.options).map((o, i) => `<li class="${i === p.correctIndex ? "right" : ""}">${esc(o)}${i === p.correctIndex ? " ✓" : ""}</li>`).join("")}</ul>`;
  if (format === "pick_all") { const right = new Set(list(p.correctIndexes) as unknown as number[]); return `<ul class="opts">${list(p.options).map((o, i) => `<li class="${right.has(i) ? "right" : ""}">${esc(o)}${right.has(i) ? " ✓" : ""}</li>`).join("")}</ul>`; }
  if (format === "order") { const items = list(p.items); return `<p class="meta">Shown: ${items.map(esc).join(" · ")}</p><ul class="opts">${(list(p.correctOrder) as unknown as number[]).map((i) => `<li class="right">${esc(items[i])}</li>`).join("")}</ul>`; }
  const left = list(p.left); const right = list(p.right); const pairs = list(p.pairs) as unknown as number[];
  return `<ul class="opts">${left.map((l, i) => `<li class="right">${esc(l)} → ${esc(right[pairs[i]])}</li>`).join("")}</ul>`;
}

function card(q: EvalQuestion): string {
  const p = q.draft.payload as Record<string, unknown>;
  const [label, tone] = OUTCOME[q.outcome] ?? [q.outcome, "warn"];
  const v = q.verify;
  const vTone = v?.verdict === "correct" ? "good" : v?.verdict === "unverifiable" ? "warn" : "bad";
  const sources = (v?.citations ?? v?.sources.map((url) => ({ url })) ?? [])
    .map((s) => (/^https?:/.test(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc((s as { title?: string }).title ?? s.url)}</a>` : esc((s as { title?: string }).title ?? s.url))).join(" · ");
  return `<article class="q"><header><span class="tag ${tone} out">${esc(label)}</span><span class="tag">${esc(q.draft.format.replace("_", " "))}</span><span class="tag">${esc(q.difficultyBand)}</span>${v?.verifiedBy?.cached ? '<span class="tag">verdict cached</span>' : ""}</header>
<div class="qt">${esc(p.question)}</div>${p.imageAlt ? `<div class="img">Picture: ${esc(p.imageAlt)} <span class="meta">(${esc(p.imageUrl)})</span></div>` : ""}
${options(q.draft.format, p)}
<dl class="kv">
<dt>Explanation</dt><dd>${esc(q.draft.explanation ?? "–")}</dd>
<dt>Claim</dt><dd>${esc(q.draft.claim)}</dd>
<dt>Verdict</dt><dd class="${vTone}">${v ? `${esc(v.verdict)}${v.foundAnswer ? ` — found: ${esc(v.foundAnswer)}` : ""}${v.note ? ` — ${esc(v.note)}` : ""}` : "not checked (invalid shape)"}</dd>
<dt>Sources</dt><dd>${sources || "–"}</dd>
<dt>Safety</dt><dd class="${q.safety.passed ? "good" : "bad"}">${q.safety.passed ? "passed" : esc(q.safety.reasons.join(", "))} <span class="meta">(${esc(q.safety.reviewedBy ?? "")})</span></dd>
<dt>Nearest</dt><dd>${q.nearest ? `${q.nearest.similarity.toFixed(3)} similarity` : "–"}</dd>
<dt>Written by</dt><dd>${esc(q.draft.generatedBy ? `${q.draft.generatedBy.provider} ${q.draft.generatedBy.model}` : "mock")}${v?.verifiedBy ? ` · checked by ${esc(`${v.verifiedBy.provider} ${v.verifiedBy.model}`)}` : ""}${q.draft.sourceChunkId ? ` · cites ${esc(q.draft.sourceChunkId)}` : ""}</dd>
</dl></article>`;
}
