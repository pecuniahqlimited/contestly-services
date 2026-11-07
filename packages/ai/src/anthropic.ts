/**
 * Claude, through the official SDK: one structured-output call that returns JSON matching a schema, optionally
 * with Anthropic's web search tool (server-side; the results Claude saw come back with the answer). The SDK's
 * own retries are off (providerCall owns retries, timeouts and the breaker); its typed errors are mapped to
 * ProviderError here, and no SDK type leaves this file.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { CallUsage } from "@contestly/shared";
import { kindForStatus, ProviderError, retryAfterMs } from "./errors.js";
import type { CallOutput } from "./call.js";
import { parseJson } from "./json.js";

export type ClaudeClient = Anthropic;

export function claudeClient(opts: { apiKey: string; fetch?: typeof fetch; baseURL?: string }): ClaudeClient {
  if (!opts.apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey: opts.apiKey, maxRetries: 0, fetch: opts.fetch, baseURL: opts.baseURL });
}

export interface ClaudeJsonRequest {
  model: string;
  system: string;
  user: string;
  /** A JSON schema (objects closed with additionalProperties: false). Counts and lengths are checked by the caller. */
  schema: Record<string, unknown>;
  maxTokens: number;
  effort: "low" | "medium" | "high";
  /** Let Claude search the web, up to this many queries. Called directly (no dynamic filtering): one fewer moving part, and fewer tokens for a one-fact check. */
  webSearch?: { maxUses: number };
}

export interface SearchResultSeen {
  url: string;
  title?: string;
}

export interface ClaudeJsonAnswer {
  json: unknown;
  /** Every web search result Claude was shown, in order, de-duplicated by URL. Empty without webSearch. */
  results: SearchResultSeen[];
}

/** Server-side tool turns the API may pause (pause_turn); each continuation is the same call, resumed. */
const MAX_CONTINUATIONS = 3;
const WEB_SEARCH_TOOL = "web_search_20260209";

/** One call (resumed after pause_turn if the API pauses it); resolves to the parsed JSON (validated by the caller) and the usage it cost. */
export async function claudeJson(client: ClaudeClient, req: ClaudeJsonRequest, signal: AbortSignal): Promise<CallOutput<ClaudeJsonAnswer>> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.user }];
  const usage: Required<Pick<CallUsage, "inputTokens" | "cachedInputTokens" | "outputTokens" | "searchQueries">> = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, searchQueries: 0 };
  const results = new Map<string, SearchResultSeen>();
  let message: Anthropic.Message;
  for (let turn = 0; ; turn++) {
    try {
      message = await client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages,
        thinking: { type: "adaptive" },
        output_config: { effort: req.effort, format: { type: "json_schema", schema: req.schema } },
        ...(req.webSearch ? { tools: [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: req.webSearch.maxUses, allowed_callers: ["direct"] }] } : {}),
      } as Anthropic.MessageCreateParamsNonStreaming, { signal });
    } catch (err) {
      throw toProviderError(err);
    }
    const u = message.usage;
    usage.inputTokens += u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    usage.cachedInputTokens += u.cache_read_input_tokens ?? 0;
    usage.outputTokens += u.output_tokens;
    usage.searchQueries += u.server_tool_use?.web_search_requests ?? 0;
    for (const b of message.content) {
      if (b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
      for (const r of b.content) if (r.url && !results.has(r.url)) results.set(r.url, { url: r.url, ...(r.title ? { title: r.title } : {}) });
    }
    if (message.stop_reason !== "pause_turn") break;
    if (turn + 1 >= MAX_CONTINUATIONS) throw new ProviderError("malformed", `still paused after ${MAX_CONTINUATIONS} continuations`);
    messages.splice(1, messages.length - 1, { role: "assistant", content: message.content as Anthropic.ContentBlockParam[] });
  }
  if (message.stop_reason === "refusal") throw new ProviderError("refused", `declined (${message.stop_details?.category ?? "no category"})`);
  if (message.stop_reason === "max_tokens") throw new ProviderError("malformed", `output cut off at max_tokens (${req.maxTokens})`);
  const texts = message.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
  // With a tool in the turn, Claude may say a line before searching; the answer is the last text block.
  const json = parseJson(texts.join("")) ?? parseJson(texts.at(-1) ?? "");
  if (json === undefined) throw new ProviderError("malformed", `output is not JSON (${texts.join("").length} chars)`);
  return { value: { json, results: [...results.values()] }, usage };
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("timeout", "request timed out");
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError("timeout", "request aborted");
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError("network", "could not reach the API");
  if (err instanceof Anthropic.APIError && typeof err.status === "number") {
    const kind = err.status === 529 ? "server" : kindForStatus(err.status);
    return new ProviderError(kind, `HTTP ${err.status}: ${shortMessage(err)}`, retryAfterMs(err.headers?.get("retry-after")));
  }
  return new ProviderError("network", (err as Error)?.message ?? "unknown error");
}

/** The API's own error text, without the request id clutter; never anything we sent. */
function shortMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: string } } | undefined;
  return (body?.error?.message ?? err.message).slice(0, 200);
}
