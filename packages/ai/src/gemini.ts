/**
 * Gemini over its REST API with plain fetch (injectable, so tests mock HTTP): generateContent with an optional
 * JSON schema, Google Search grounding and inline audio, and embedContent. The key goes in the
 * x-goog-api-key header, never the URL, so no logged URL or error ever carries it.
 */
import type { CallUsage } from "@contestly/shared";
import { kindForStatus, ProviderError, retryAfterMs } from "./errors.js";
import type { CallOutput } from "./call.js";
import { parseJson } from "./json.js";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiClient {
  apiKey: string;
  fetch: typeof fetch;
  baseUrl: string;
}

export function geminiClient(opts: { apiKey: string; fetch?: typeof fetch; baseUrl?: string }): GeminiClient {
  if (!opts.apiKey) throw new Error("GEMINI_API_KEY is not set");
  return { apiKey: opts.apiKey, fetch: opts.fetch ?? fetch, baseUrl: opts.baseUrl ?? GEMINI_BASE_URL };
}

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GeminiGenerateRequest {
  model: string;
  system?: string;
  parts: GeminiPart[];
  /** JSON schema for the answer; the reply is parsed as JSON. */
  schema?: Record<string, unknown>;
  /** Ground the answer with Google Search; the sources come back with it. */
  search?: boolean;
  thinkingLevel?: "low" | "medium" | "high";
  maxOutputTokens?: number;
}

export interface GroundingSource {
  url: string;
  title?: string;
}

export interface GeminiAnswer {
  text: string;
  /** The parsed reply when a schema was given. */
  json: unknown;
  queries: string[];
  sources: GroundingSource[];
}

interface GenerateResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
    groundingMetadata?: { webSearchQueries?: string[]; groundingChunks?: { web?: { uri?: string; title?: string } }[] };
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
    cachedContentTokenCount?: number;
    promptTokensDetails?: { modality?: string; tokenCount?: number }[];
  };
}

/** Finish reasons that mean the model stopped for policy, not because it was done. */
const BLOCKED_FINISH = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE", "OTHER"]);

export async function geminiGenerate(client: GeminiClient, req: GeminiGenerateRequest, signal: AbortSignal): Promise<CallOutput<GeminiAnswer>> {
  const body = {
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    contents: [{ role: "user", parts: req.parts }],
    ...(req.search ? { tools: [{ googleSearch: {} }] } : {}),
    generationConfig: {
      ...(req.schema ? { responseMimeType: "application/json", responseJsonSchema: req.schema } : {}),
      ...(req.thinkingLevel ? { thinkingConfig: { thinkingLevel: req.thinkingLevel } } : {}),
      ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
    },
  };
  const res = await post<GenerateResponse>(client, `models/${req.model}:generateContent`, body, signal);
  const u = res.usageMetadata ?? {};
  const audio = (u.promptTokensDetails ?? []).filter((d) => d.modality === "AUDIO").reduce((a, d) => a + (d.tokenCount ?? 0), 0);
  const candidate = res.candidates?.[0];
  const grounding = candidate?.groundingMetadata;
  const usage: CallUsage = {
    inputTokens: (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0),
    cachedInputTokens: u.cachedContentTokenCount ?? 0,
    audioInputTokens: audio,
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    searchQueries: grounding?.webSearchQueries?.length ?? 0,
  };
  if (res.promptFeedback?.blockReason) throw new ProviderError("refused", `prompt blocked (${res.promptFeedback.blockReason})`);
  if (!candidate) throw new ProviderError("malformed", "no candidate in the response");
  if (candidate.finishReason && BLOCKED_FINISH.has(candidate.finishReason)) throw new ProviderError("refused", `stopped: ${candidate.finishReason}`);
  if (candidate.finishReason === "MAX_TOKENS") throw new ProviderError("malformed", "output cut off at max tokens");
  const text = (candidate.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  let json: unknown;
  if (req.schema) {
    json = parseJson(text);
    if (json === undefined) throw new ProviderError("malformed", `output is not JSON (${text.length} chars)`);
  }
  const sources = (grounding?.groundingChunks ?? []).flatMap((c) => (c.web?.uri ? [{ url: c.web.uri, ...(c.web.title ? { title: c.web.title } : {}) }] : []));
  return { value: { text, json, queries: grounding?.webSearchQueries ?? [], sources }, usage };
}

export interface GeminiEmbedRequest {
  model: string;
  texts: string[];
  dimensions: number;
}

/** One embedContent request per text (the model's batch endpoint is async-only); the caller batches calls. */
export async function geminiEmbed(client: GeminiClient, req: GeminiEmbedRequest, signal: AbortSignal): Promise<CallOutput<number[][]>> {
  const replies = await Promise.all(req.texts.map((text) =>
    post<{ embedding?: { values?: number[] }; usageMetadata?: { promptTokenCount?: number } }>(
      client, `models/${req.model}:embedContent`, { content: { parts: [{ text }] }, outputDimensionality: req.dimensions }, signal,
    )));
  const vectors = replies.map((r, i) => {
    const v = r.embedding?.values;
    if (!Array.isArray(v) || v.length !== req.dimensions) throw new ProviderError("malformed", `embedding ${i} has ${v?.length ?? 0} values, expected ${req.dimensions}`);
    return v;
  });
  const inputTokens = replies.reduce((a, r) => a + (r.usageMetadata?.promptTokenCount ?? 0), 0);
  return { value: vectors, usage: { inputTokens, outputTokens: 0 } };
}

async function post<T>(client: GeminiClient, path: string, body: unknown, signal: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await client.fetch(`${client.baseUrl}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": client.apiKey },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw new ProviderError("timeout", "request aborted");
    throw new ProviderError("network", "could not reach the API");
  }
  const raw = await res.text();
  if (!res.ok) {
    // Not JSON (a proxy's page): the first bytes are the message.
    const error = (parseJson(raw) as { error?: GeminiErrorBody } | undefined)?.error;
    const message = error?.message?.slice(0, 200) ?? raw.slice(0, 200);
    // Which quota ran out (per minute or per day) comes first: the message's own text names it only after its links.
    const quota = error?.details?.find((d) => d["@type"]?.endsWith("google.rpc.QuotaFailure"))?.violations?.[0]?.quotaId;
    throw new ProviderError(kindForStatus(res.status), `HTTP ${res.status}${quota ? ` ${quota}` : ""}: ${message}`, retryAfterMs(res.headers.get("retry-after")) ?? retryDelayMs(error));
  }
  const parsed = parseJson(raw);
  if (parsed === undefined) throw new ProviderError("malformed", `response is not JSON (${raw.length} bytes)`);
  return parsed as T;
}

interface GeminiErrorBody {
  message?: string;
  details?: { "@type"?: string; retryDelay?: string; violations?: { quotaId?: string }[] }[];
}

/** A quota 429 says when to come back in its RetryInfo detail ("11s"), not in a Retry-After header. */
export function retryDelayMs(error: GeminiErrorBody | undefined): number | undefined {
  const delay = error?.details?.find((d) => d["@type"]?.endsWith("google.rpc.RetryInfo"))?.retryDelay;
  const seconds = delay ? Number.parseFloat(delay) : Number.NaN;
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : undefined;
}
