/**
 * The question generator, whichever model writes (ADR 0016; one call per set since 11 Nov 2026): the requested
 * count is spread across the spec's formats and asked for in one structured-output call, the questions keyed by
 * format, each format with its own template and item schema. A call that fails leaves the generator unavailable
 * for the round (the pipeline then falls back to the bank). The vendor is a plain "structured call"
 * (anthropic/generator.ts, gemini/generator.ts); the model comes per call from the profile. The same call
 * writes a host-written question's wrong options (distract).
 */
import type { PricedModel, ProviderName, QuestionFormat } from "@contestly/shared";
import type { DraftQuestion, GenerationSpec, Generator, SourceChunk } from "../types.js";
import { IMAGE_POOL, type PoolImage } from "../imagePool.js";
import { FORMAT_TEMPLATES } from "./formats.js";
import { SYSTEM_PROMPT, userPrompt } from "./prompt.js";
import { DISTRACT_SYSTEM, distractPrompt, distractSchema, distractorsFrom } from "./distract.js";

/**
 * Output for a set: thinking plus the questions (a few hundred tokens each; a set with its buffer is about 5,000).
 * Kept under what Anthropic's SDK allows a non-streaming call.
 */
export const MAX_TOKENS = 16_000;

/** One structured call through providerCall: the parsed JSON, which the generator validates. */
export type StructuredAsk = (req: { model: PricedModel; system: string; user: string; schema: Record<string, unknown> }) => Promise<unknown>;

export interface StructuredGeneratorDeps {
  provider: ProviderName;
  ask: StructuredAsk;
  /** The model for this step, read per call so an admin change applies to the next set. */
  model: () => Promise<PricedModel>;
}

export interface Share {
  format: QuestionFormat;
  count: number;
}

/**
 * The count spread across formats as evenly as possible (earlier formats take the remainder), a capped format
 * giving what it can't take to the others (or dropping it when every format is capped). Formats with no share are
 * left out.
 */
export function planShares(count: number, formats: QuestionFormat[], maxPerFormat: Partial<Record<QuestionFormat, number>> = {}): Share[] {
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
  return formats.flatMap((format) => ((shares.get(format) ?? 0) > 0 ? [{ format, count: shares.get(format)! }] : []));
}

export function structuredGenerator(deps: StructuredGeneratorDeps): Generator {
  return {
    async draft({ spec, count, avoid, sources, maxPerFormat = {} }) {
      // Picture rounds need a pool image; a file has none, so file-scoped sets skip that format. A set never asks
      // for more pictures than there are images.
      const formats = spec.formats.filter((f) => f !== "picture" || (!sources && IMAGE_POOL.length > 0));
      const shares = planShares(count, formats, { ...maxPerFormat, picture: Math.min(maxPerFormat.picture ?? Infinity, IMAGE_POOL.length) });
      if (!shares.length) return [];
      return draftSet(deps, await deps.model(), spec, shares, avoid, sources);
    },
    /** A host-written question's wrong options (ADR 0015): one call; the pipeline filters them. */
    async distract(input) {
      const model = await deps.model();
      return distractorsFrom(await deps.ask({ model, system: DISTRACT_SYSTEM, user: distractPrompt(input), schema: distractSchema(input.count) }), input.count);
    },
  };
}

/** The whole set in one call; each format's items mapped by its template. An item that doesn't fit is dropped, never repaired. */
async function draftSet(deps: StructuredGeneratorDeps, model: PricedModel, spec: GenerationSpec, shares: Share[], avoid: string[], sources?: SourceChunk[]): Promise<DraftQuestion[]> {
  const images: PoolImage[] = shares.some((s) => s.format === "picture") ? IMAGE_POOL : [];
  const schema = setSchema(shares.map((s) => s.format), images, !!sources);
  const user = userPrompt({ spec, formats: shares.map((s) => ({ ...s, instructions: FORMAT_TEMPLATES[s.format].instructions })), avoid, sources, images: images.length ? images : undefined });
  const raw = await deps.ask({ model, system: SYSTEM_PROMPT, user, schema });

  const byFormat = (raw as { questions?: Record<string, unknown> })?.questions ?? {};
  const chunkIds = new Set(sources?.map((c) => c.id));
  const drafts: DraftQuestion[] = [];
  const dropped: string[] = [];
  for (const { format, count } of shares) {
    const template = FORMAT_TEMPLATES[format];
    const items = Array.isArray(byFormat[format]) ? (byFormat[format] as Record<string, unknown>[]) : [];
    const kept: DraftQuestion[] = [];
    for (const item of items) {
      const mapped = template.toPayload(item, { images });
      if ("error" in mapped) {
        dropped.push(`${format}: ${mapped.error}`);
        continue;
      }
      const claim = String(item.claim ?? "").trim();
      const sourceChunkId = sources ? String(item.sourceChunkId ?? "") : undefined;
      if (!claim) dropped.push(`${format}: no claim`);
      else if (sources && !chunkIds.has(sourceChunkId!)) dropped.push(`${format}: cites a chunk it wasn't given`);
      else kept.push({
        format, payload: mapped.payload, claim,
        explanation: String(item.explanation ?? "").trim() || undefined,
        ...(sourceChunkId ? { sourceChunkId } : {}),
        generatedBy: { provider: deps.provider, model },
      });
    }
    drafts.push(...kept.slice(0, count));
  }
  if (dropped.length) console.warn(`[questions] generator: dropped ${dropped.length} item(s): ${[...new Set(dropped)].join("; ")}`);
  return drafts;
}

/** The set's structured-output schema: `questions` holds a list per format, each item the shared fields plus the format's own. */
function setSchema(formats: QuestionFormat[], images: PoolImage[], fileScoped: boolean): Record<string, unknown> {
  const shared: Record<string, unknown> = { question: { type: "string" }, claim: { type: "string" }, explanation: { type: "string" } };
  if (fileScoped) shared.sourceChunkId = { type: "string" };
  const perFormat = Object.fromEntries(formats.map((f) => {
    const properties = { ...shared, ...FORMAT_TEMPLATES[f].fields({ images }) };
    return [f, { type: "array", items: { type: "object", additionalProperties: false, required: Object.keys(properties), properties } }];
  }));
  return {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: { questions: { type: "object", additionalProperties: false, required: formats, properties: perFormat } },
  };
}
