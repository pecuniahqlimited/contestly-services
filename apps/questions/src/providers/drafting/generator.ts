/**
 * The question generator, whichever model writes (ADR 0016): the requested count is split across the spec's
 * formats, and each format's share is one structured-output call (a batch) with that format's template.
 * Calls run in parallel; a format whose call fails is skipped and the others still count, and only when every
 * call fails is the generator unavailable (the pipeline then falls back to the bank). The vendor is a plain
 * "structured call" (anthropic/generator.ts, gemini/generator.ts); the model comes per call from the profile.
 */
import { ProviderUnavailable } from "@contestly/ai";
import type { PricedModel, ProviderName, QuestionFormat } from "@contestly/shared";
import type { DraftQuestion, GenerationSpec, Generator, SourceChunk } from "../types.js";
import { IMAGE_POOL, type PoolImage } from "../imagePool.js";
import { FORMAT_TEMPLATES } from "./formats.js";
import { SYSTEM_PROMPT, userPrompt } from "./prompt.js";

/** Questions per call: enough to amortise the prompt, few enough that one bad call costs little. */
export const MAX_PER_CALL = 8;
export const MAX_TOKENS = 16_000;

/** One structured call through providerCall: the parsed JSON, which the generator validates. */
export type StructuredAsk = (req: { model: PricedModel; system: string; user: string; schema: Record<string, unknown> }) => Promise<unknown>;

export interface StructuredGeneratorDeps {
  provider: ProviderName;
  ask: StructuredAsk;
  /** The model for this step, read per call so an admin change applies to the next set. */
  model: () => Promise<PricedModel>;
}

interface Batch {
  format: QuestionFormat;
  count: number;
}

/**
 * The count spread across formats as evenly as possible (earlier formats take the remainder), a capped
 * format giving what it can't take to the others (or dropping it when every format is capped), split into
 * calls of at most MAX_PER_CALL.
 */
export function planBatches(count: number, formats: QuestionFormat[], maxPerFormat: Partial<Record<QuestionFormat, number>> = {}): Batch[] {
  const shares = new Map<QuestionFormat, number>();
  let open = formats.filter((f) => (maxPerFormat[f] ?? Infinity) > 0);
  let left = count;
  while (left > 0 && open.length) {
    const base = Math.floor(left / open.length);
    const extra = left % open.length;
    left = 0;
    for (const [i, f] of open.entries()) {
      const want = (shares.get(f) ?? 0) + base + (i < extra ? 1 : 0);
      const cap = maxPerFormat[f] ?? Infinity;
      shares.set(f, Math.min(want, cap));
      left += Math.max(0, want - cap);
    }
    open = open.filter((f) => (shares.get(f) ?? 0) < (maxPerFormat[f] ?? Infinity));
  }
  return formats.flatMap((format) => {
    let n = shares.get(format) ?? 0;
    const out: Batch[] = [];
    while (n > 0) {
      out.push({ format, count: Math.min(n, MAX_PER_CALL) });
      n -= MAX_PER_CALL;
    }
    return out;
  });
}

export function structuredGenerator(deps: StructuredGeneratorDeps): Generator {
  return {
    async draft({ spec, count, avoid, sources, maxPerFormat = {} }) {
      // Picture rounds need a pool image; a file has none, so file-scoped sets skip that format. One call
      // never asks for more pictures than there are images.
      const formats = spec.formats.filter((f) => f !== "picture" || (!sources && IMAGE_POOL.length > 0));
      const batches = planBatches(count, formats, { ...maxPerFormat, picture: Math.min(maxPerFormat.picture ?? Infinity, IMAGE_POOL.length) });
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

async function draftBatch(deps: StructuredGeneratorDeps, model: PricedModel, spec: GenerationSpec, batch: Batch, avoid: string[], sources?: SourceChunk[]): Promise<DraftQuestion[]> {
  const template = FORMAT_TEMPLATES[batch.format];
  const images: PoolImage[] = batch.format === "picture" ? IMAGE_POOL : [];
  const schema = batchSchema(template.fields({ images }), !!sources);
  const user = userPrompt({ spec, count: batch.count, formatInstructions: template.instructions, avoid, sources, images: images.length ? images : undefined });
  const raw = await deps.ask({ model, system: SYSTEM_PROMPT, user, schema });

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
      generatedBy: { provider: deps.provider, model },
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
