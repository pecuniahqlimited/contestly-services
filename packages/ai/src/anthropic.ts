/**
 * Claude, through the official SDK: one structured-output call that returns JSON matching a schema. The SDK's
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
}

/** One call; resolves to the parsed JSON (validated by the caller) and the usage it cost. */
export async function claudeJson(client: ClaudeClient, req: ClaudeJsonRequest, signal: AbortSignal): Promise<CallOutput<unknown>> {
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      thinking: { type: "adaptive" },
      output_config: { effort: req.effort, format: { type: "json_schema", schema: req.schema } },
    }, { signal });
  } catch (err) {
    throw toProviderError(err);
  }
  const usage: CallUsage = {
    inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
    cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
    outputTokens: message.usage.output_tokens,
  };
  if (message.stop_reason === "refusal") throw new ProviderError("refused", `declined (${message.stop_details?.category ?? "no category"})`);
  if (message.stop_reason === "max_tokens") throw new ProviderError("malformed", `output cut off at max_tokens (${req.maxTokens})`);
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const value = parseJson(text);
  if (value === undefined) throw new ProviderError("malformed", `output is not JSON (${text.length} chars)`);
  return { value, usage };
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
