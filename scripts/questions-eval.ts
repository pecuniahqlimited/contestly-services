/**
 * The question engine's quality harness (ADR 0016): `npm run questions:eval`.
 *
 * Generates sets across lanes (Afrobeats, Nollywood, Naija football, general knowledge) at every difficulty,
 * each asking for every format, plus one file-scoped set from a sample PDF, through the real pipeline
 * (draftAndJudge: generate → verify → term filter → model safety → embed → dedupe → gate). Nothing is written
 * to the bank or to any party; provider calls are recorded in provider_calls (job "eval") like any other, so
 * they count against the day's cap. Reports pass rates at each step, latency and cost per question, and
 * writes an HTML page of every question with its answer, distractors, verdict and sources to
 * docs/engineering/eval/.
 *
 *   npm run questions:eval                    real providers from .env (QUESTIONS_GENERATOR=anthropic, QUESTIONS_VERIFIER=live, …)
 *   npm run questions:eval -- --max-usd 5     stop starting new sets past this spend (default 15)
 *   npm run questions:eval -- --mock          the mocks, to check the harness itself (free)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { Breakers, DEFAULT_BREAKER, DEFAULT_RETRY, MemorySink, withCallContext, type BudgetGate, type CallDeps, type CallRecord, type UsageSink } from "@contestly/ai";
import { dbBudgetGate, dbUsageSink, getQuestionsConfig } from "@contestly/db";
import { DIFFICULTIES, QUESTION_FORMATS, type Difficulty, type QuestionFormat } from "@contestly/shared";
import { draftAndJudge, type JudgedDraft } from "../apps/questions/src/pipeline/judge.js";
import { buildSpec } from "../apps/questions/src/pipeline/spec.js";
import { answerKeyText } from "../apps/questions/src/pipeline/text.js";
import { mapLimit } from "../apps/questions/src/pipeline/concurrency.js";
import { providerNames, selectProviders, STEP_RETRY, STEP_TIMEOUT_MS } from "../apps/questions/src/providers/index.js";
import type { GenerationSpec, SourceChunk } from "../apps/questions/src/providers/types.js";
import { readChunks } from "../apps/api/src/sources/readChunks.js";
import { minimalPdf } from "./sim-pdf.js";
import { renderReport } from "./questions-eval-report.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

if (flag("mock")) for (const k of ["QUESTIONS_GENERATOR", "QUESTIONS_VERIFIER", "QUESTIONS_EMBEDDER", "QUESTIONS_SAFETY"]) process.env[k] = "mock";
const MAX_USD = Number(value("max-usd", "15"));
/** Accepted questions each set asks for (the pipeline drafts this plus its quality buffer). */
const WANT_PER_SET = 5;
const SET_CONCURRENCY = 4;
const SECONDS = 20;

export const LANES = [
  { lane: "Afrobeats", brief: "Afrobeats: the Nigerian artists, songs, albums and moments that took the sound worldwide" },
  { lane: "Nollywood", brief: "Nollywood: Nigerian films, actors, directors and classics, from the home-video era to today" },
  { lane: "Naija football", brief: "Naija football: the Super Eagles and Super Falcons, AFCON and World Cups, the NPFL and Nigerian players abroad" },
  { lane: "General knowledge", brief: "General knowledge about Nigeria: geography, history, food, languages, culture and landmarks" },
];

/** A short sample source for the file-scoped set: the questions must come only from it. */
const SAMPLE_FILE_LINES = [
  "A short history of the bridges of Lagos.",
  "Lagos is built around a lagoon, and for most of its history people crossed the water by canoe and ferry.",
  "The first Carter Bridge was opened in 1901 and linked Lagos Island to Ebute Metta on the mainland.",
  "It was named after Sir Gilbert Carter, who was governor of the Lagos Colony in the 1890s.",
  "The bridge that carries the name today is a later replacement, completed in the 1970s.",
  "Eko Bridge was completed in 1975 to take traffic off the older crossing and to serve the port at Apapa.",
  "The Third Mainland Bridge was opened in 1990 and runs from Oworonshoki on the mainland to Adeniji Adele on Lagos Island.",
  "At about 11.8 kilometres it was for many years the longest bridge in Africa.",
  "It was built by the German firm Julius Berger, which also built much of Abuja.",
  "The bridge was closed for repairs in stages in 2018 and again in 2020, and traffic was diverted to Carter and Eko bridges.",
  "The Lekki-Ikoyi Link Bridge opened in 2013 and was the first cable-stayed bridge in Nigeria.",
  "It is 1.36 kilometres long and links Lekki Phase 1 with Ikoyi.",
  "The bridge charges a toll for cars, and in the evenings its white cables are lit in changing colours.",
  "Ferries still matter: the Lagos State Waterways Authority licenses boats that run from Ikorodu, Badore and Falomo.",
  "Planners expect the Fourth Mainland Bridge, proposed to link Ikorodu with the Lekki peninsula, to be longer than the Third Mainland Bridge.",
];

interface SetDef {
  id: string;
  lane: string;
  difficulty: Difficulty;
  spec: GenerationSpec;
  sources?: SourceChunk[];
}

export interface EvalQuestion extends JudgedDraft {
  set: string;
  lane: string;
  difficultyBand: Difficulty;
  answerKey: string;
}

export interface EvalResult {
  startedAt: string;
  finishedAt: string;
  providers: Record<string, string>;
  models: Record<string, string>;
  maxUsd: number;
  sets: { id: string; lane: string; difficulty: Difficulty; fileScoped: boolean; wanted: number; accepted: number; drafted: number; ms: number; unavailable: string[]; skipped?: string }[];
  questions: EvalQuestion[];
  calls: CallRecord[];
}

/** Records to Postgres like any call, and keeps a copy for the report. */
function teeSink(memory: MemorySink): UsageSink {
  return { async record(r) { await memory.record(r); await dbUsageSink.record(r); } };
}

/** The day's caps (the real gate) plus the eval's own ceiling. */
function evalBudget(memory: MemorySink): BudgetGate {
  return {
    async check(input) {
      const spent = memory.records.reduce((a, r) => a + r.costMicros, 0) / 1_000_000;
      if (spent >= MAX_USD) return `the eval's ceiling ($${MAX_USD}) is spent`;
      return dbBudgetGate.check(input);
    },
  };
}

async function fileSources(): Promise<SourceChunk[]> {
  const read = await readChunks({ contentType: "application/pdf", bytes: minimalPdf(SAMPLE_FILE_LINES) });
  if (!read.ok) throw new Error(`sample PDF couldn't be read: ${read.reason}`);
  return read.chunks.map((text, i) => ({ id: `sample-chunk-${i}`, text }));
}

async function main() {
  const startedAt = new Date().toISOString();
  const memory = new MemorySink();
  const breakers = new Breakers(DEFAULT_BREAKER);
  const deps = (step: keyof typeof STEP_TIMEOUT_MS): CallDeps => ({ sink: teeSink(memory), budget: evalBudget(memory), breakers, retry: STEP_RETRY[step] ?? DEFAULT_RETRY, timeoutMs: STEP_TIMEOUT_MS[step] });
  const providers = selectProviders(deps);
  const cfg = await getQuestionsConfig();
  const names = providerNames();
  console.log(`[eval] providers ${JSON.stringify(names)}, models ${JSON.stringify(cfg.providers.models)}, embed ${providers.embedder.model}, ceiling $${MAX_USD}`);

  const sets: SetDef[] = [];
  for (const { lane, brief } of LANES) for (const difficulty of DIFFICULTIES) {
    sets.push({ id: `${lane} · ${difficulty}`, lane, difficulty, spec: buildSpec({ brief, difficulty, formats: [...QUESTION_FORMATS], questionCount: WANT_PER_SET, questionSeconds: SECONDS }) });
  }
  const sources = await fileSources();
  const fileFormats: QuestionFormat[] = ["pick_one", "pick_all", "order", "match"];
  sets.push({
    id: "Sample PDF · mixed", lane: "From a file", difficulty: "mixed", sources,
    spec: buildSpec({ brief: "Lagos bridges, from the attached notes", difficulty: "mixed", formats: fileFormats, questionCount: WANT_PER_SET, questionSeconds: SECONDS, fileIds: ["sample"] }),
  });

  const result: EvalResult = { startedAt, finishedAt: "", providers: { ...names, embedModel: providers.embedder.model }, models: cfg.providers.models, maxUsd: MAX_USD, sets: [], questions: [], calls: memory.records };
  await mapLimit(sets, SET_CONCURRENCY, async (s) => {
    const spent = memory.records.reduce((a, r) => a + r.costMicros, 0) / 1_000_000;
    if (spent >= MAX_USD) {
      result.sets.push({ id: s.id, lane: s.lane, difficulty: s.difficulty, fileScoped: !!s.sources, wanted: WANT_PER_SET, accepted: 0, drafted: 0, ms: 0, unavailable: [], skipped: "eval ceiling reached" });
      return;
    }
    const t0 = Date.now();
    const out = await withCallContext({ partyId: null, job: "eval" }, () => draftAndJudge({
      spec: s.spec, providers, dedupeSimilarity: cfg.dedupeSimilarity, want: WANT_PER_SET, avoid: [], sources: s.sources,
    }));
    const ms = Date.now() - t0;
    result.sets.push({ id: s.id, lane: s.lane, difficulty: s.difficulty, fileScoped: !!s.sources, wanted: WANT_PER_SET, accepted: out.accepted.length, drafted: out.judged.length, ms, unavailable: out.unavailable });
    for (const j of out.judged) result.questions.push({ ...j, set: s.id, lane: s.lane, difficultyBand: s.difficulty, answerKey: answerKeyText(j.draft.format, j.draft.payload) });
    console.log(`[eval] ${s.id}: ${out.accepted.length}/${WANT_PER_SET} accepted of ${out.judged.length} drafted in ${(ms / 1000).toFixed(0)}s${out.unavailable.length ? ` (${out.unavailable.join(", ")} unavailable)` : ""}`);
  });
  result.finishedAt = new Date().toISOString();
  const order = new Map(sets.map((s, i) => [s.id, i]));
  result.sets.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  result.questions.sort((a, b) => order.get(a.set)! - order.get(b.set)!);

  const day = startedAt.slice(0, 10);
  const dir = new URL("../docs/engineering/eval/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const base = `questions-eval-${day}${flag("mock") ? "-mock" : ""}`;
  const { html, summary } = renderReport(result);
  await writeFile(new URL(`${base}.html`, dir), html);
  await writeFile(new URL(`${base}.json`, dir), JSON.stringify({ ...result, questions: result.questions.map(({ embedding: _e, ...q }) => q) }, null, 2));
  console.log(`\n${summary}\n\n[eval] report: docs/engineering/eval/${base}.html`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
