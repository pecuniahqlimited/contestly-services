/**
 * The Claude generator (ADR 0016): the requested count is split across the spec's formats, and each format's
 * share is one structured-output call (a batch) with that format's template. Calls run in parallel; a format
 * whose call fails is skipped and the others still count, and only when every call fails is the generator
 * unavailable (the pipeline then falls back to the bank). The model comes from admin config per step.
 */
import { claudeJson, providerCall, ProviderUnavailable, type CallDeps, type ClaudeClient } from "@contestly/ai";
import type { PricedModel, QuestionFormat } from "@contestly/shared";
import type { DraftQuestion, GenerationSpec, Generator, SourceChunk } from "../types.js";
import { IMAGE_POOL, type PoolImage } from "../imagePool.js";
import { FORMAT_TEMPLATES } from "./formats.js";
import { SYSTEM_PROMPT, userPrompt } from "./prompt.js";

/** Questions per call: enough to amortise the prompt, few enough that one bad call costs little. */
export const MAX_PER_CALL = 8;
const MAX_TOKENS = 16_000;
const EFFORT = "medium";

export interface AnthropicGeneratorDeps {
  client: ClaudeClient;
  call: CallDeps;
  /** The model for this step, read per call so an admin change applies to the next set. */
  model: () => Promise<PricedModel>;
}

interface Batch {
  format: QuestionFormat;
  count: number;
}

/** The count spread across formats as evenly as possible (earlier formats take the remainder), split into calls of at most MAX_PER_CALL. */
export function planBatches(count: number, formats: QuestionFormat[]): Batch[] {
  if (!formats.length || count <= 0) return [];
  const base = Math.floor(count / formats.length);
  const extra = count % formats.length;
  return formats.flatMap((format, i) => {
    let n = base + (i < extra ? 1 : 0);
    const out: Batch[] = [];
    while (n > 0) {
      out.push({ format, count: Math.min(n, MAX_PER_CALL) });
      n -= MAX_PER_CALL;
    }
    return out;
  });
}

export function anthropicGenerator(deps: AnthropicGeneratorDeps): Generator {
  return {
    async draft({ spec, count, avoid, sources }) {
      // Picture rounds need a pool image; a file has none, so file-scoped sets skip that format.
      const formats = spec.formats.filter((f) => f !== "picture" || (!sources && IMAGE_POOL.length > 0));
      const batches = planBatches(count, formats);
      if (!batches.length) return [];
      const model = await deps.model();
      const results = await Promise.allSettled(batches.map((b) => draftBatch(deps, model, spec, b, avoid, sources)));
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      for (const f of failures) if (!(f.reason instanceof ProviderUnavailable)) throw f.reason;
      if (failures.length === results.length) throw failures[0].reason;
      return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    },
  };
}

async function draftBatch(deps: AnthropicGeneratorDeps, model: PricedModel, spec: GenerationSpec, batch: Batch, avoid: string[], sources?: SourceChunk[]): Promise<DraftQuestion[]> {
  const template = FORMAT_TEMPLATES[batch.format];
  const images: PoolImage[] = batch.format === "picture" ? IMAGE_POOL : [];
  const schema = batchSchema(template.fields({ images }), !!sources);
  const user = userPrompt({ spec, count: batch.count, formatInstructions: template.instructions, avoid, sources, images: images.length ? images : undefined });
  const raw = await providerCall({ provider: "anthropic", model, step: "generate" }, deps.call, (signal) =>
    claudeJson(deps.client, { model, system: SYSTEM_PROMPT, user, schema, maxTokens: MAX_TOKENS, effort: EFFORT }, signal));

  const items = Array.isArray((raw as { questions?: unknown })?.questions) ? ((raw as { questions: Record<string, unknown>[] }).questions) : [];
  const chunkIds = new Set(sources?.map((c) => c.id));
  const drafts: DraftQuestion[] = [];
  const dropped: string[] = [];
  for (const item of items) {
    const mapped = template.toPayload(item, { images });
    if ("error" in mapped) {
      dropped.push(mapped.error);
      continue;
    }
    const claim = String(item.claim ?? "").trim();
    const sourceChunkId = sources ? String(item.sourceChunkId ?? "") : undefined;
    if (!claim) dropped.push("no claim");
    else if (sources && !chunkIds.has(sourceChunkId!)) dropped.push("cites a chunk it wasn't given");
    else drafts.push({
      format: batch.format, payload: mapped.payload, claim,
      explanation: String(item.explanation ?? "").trim() || undefined,
      ...(sourceChunkId ? { sourceChunkId } : {}),
      generatedBy: { provider: "anthropic", model },
    });
  }
  if (dropped.length) console.warn(`[questions] generator: dropped ${dropped.length} ${batch.format} item(s): ${[...new Set(dropped)].join("; ")}`);
  return drafts.slice(0, batch.count);
}

/** The structured-output schema for one call: a list of items with the shared fields plus the format's own. */
function batchSchema(fields: Record<string, unknown>, fileScoped: boolean): Record<string, unknown> {
  const shared: Record<string, unknown> = { question: { type: "string" }, claim: { type: "string" }, explanation: { type: "string" } };
  if (fileScoped) shared.sourceChunkId = { type: "string" };
  const properties = { ...shared, ...fields };
  return {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: { questions: { type: "array", items: { type: "object", additionalProperties: false, required: Object.keys(properties), properties } } },
  };
}
