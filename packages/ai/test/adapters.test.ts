import { describe, expect, it } from "vitest";
import { claudeClient, claudeJson, geminiClient, geminiEmbed, geminiGenerate, ProviderError } from "../src/index.js";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const fetchOf = (h: Handler) => (async (url: string | URL | Request, init?: RequestInit) => h(String(url), init ?? {})) as typeof fetch;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const signal = new AbortController().signal;

const claudeMessage = (text: string, stop = "end_turn") => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text }],
  stop_reason: stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
const req = { model: "claude-sonnet-5-5", system: "s", user: "u", schema: { type: "object" }, maxTokens: 100, effort: "medium" as const };

describe("claudeJson", () => {
  it("sends structured output and adaptive thinking, and parses the JSON", async () => {
    let body: Record<string, unknown> = {};
    const client = claudeClient({ apiKey: "test-key", fetch: fetchOf((_u, init) => { body = JSON.parse(String(init.body)); return json(claudeMessage('{"questions":[]}')); }) });
    const out = await claudeJson(client, req, signal);
    expect(out.value).toEqual({ questions: [] });
    expect(out.usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });
    expect(body.output_config).toEqual({ effort: "medium", format: { type: "json_schema", schema: { type: "object" } } });
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("maps malformed output, refusals, rate limits and overload to their kinds", async () => {
    const run = (r: Response) => claudeJson(claudeClient({ apiKey: "k", fetch: fetchOf(() => r) }), req, signal).catch((e: ProviderError) => e);
    expect(await run(json(claudeMessage("not json")))).toMatchObject({ kind: "malformed" });
    expect(await run(json(claudeMessage("", "refusal")))).toMatchObject({ kind: "refused" });
    expect(await run(json(claudeMessage("{", "max_tokens")))).toMatchObject({ kind: "malformed" });
    expect(await run(json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429, { "retry-after": "2" }))).toMatchObject({ kind: "rate_limited", retryAfterMs: 2000 });
    expect(await run(json({ type: "error", error: { type: "overloaded_error", message: "busy" } }, 529))).toMatchObject({ kind: "server" });
    expect(await run(json({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, 400))).toMatchObject({ kind: "bad_request" });
  });

  it("never puts the key in an error", async () => {
    const err = await claudeJson(claudeClient({ apiKey: "sk-secret-123", fetch: fetchOf(() => json({ error: { message: "nope" } }, 401)) }), req, signal).catch((e) => e);
    expect(String(err.message)).not.toContain("sk-secret-123");
  });
});

describe("geminiGenerate", () => {
  const answer = (text: string, extra: Record<string, unknown> = {}) => ({
    candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text }] }, finishReason: "STOP", ...extra }],
    usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, thoughtsTokenCount: 20, toolUsePromptTokenCount: 500 },
  });

  it("sends the key as a header, grounds with search, and returns JSON with its sources", async () => {
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;
    const client = geminiClient({ apiKey: "g-secret", fetch: fetchOf((url, init) => {
      seen = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
      return json(answer('{"verdict":"correct"}', { groundingMetadata: { webSearchQueries: ["a", "b"], groundingChunks: [{ web: { uri: "https://x.test/1", title: "x.test" } }] } }));
    }) });
    const out = await geminiGenerate(client, { model: "gemini-3.8-flash", parts: [{ text: "q" }], schema: { type: "object" }, search: true }, signal);
    expect(seen!.url).not.toContain("g-secret");
    expect(seen!.headers.get("x-goog-api-key")).toBe("g-secret");
    expect(seen!.body.tools).toEqual([{ googleSearch: {} }]);
    expect(out.value.json).toEqual({ verdict: "correct" });
    expect(out.value.sources).toEqual([{ url: "https://x.test/1", title: "x.test" }]);
    expect(out.usage).toMatchObject({ inputTokens: 700, outputTokens: 50, searchQueries: 2 });
  });

  it("maps blocked, cut-off, malformed and HTTP failures", async () => {
    const run = (r: Response) => geminiGenerate(geminiClient({ apiKey: "k", fetch: fetchOf(() => r) }), { model: "m", parts: [{ text: "q" }], schema: {} }, signal).catch((e: ProviderError) => e);
    expect(await run(json({ promptFeedback: { blockReason: "SAFETY" } }))).toMatchObject({ kind: "refused" });
    expect(await run(json({ candidates: [{ content: { parts: [{ text: "{" }] }, finishReason: "MAX_TOKENS" }] }))).toMatchObject({ kind: "malformed" });
    expect(await run(json(answer("not json")))).toMatchObject({ kind: "malformed" });
    expect(await run(json({ error: { code: 429, message: "quota" } }, 429))).toMatchObject({ kind: "rate_limited" });
    expect(await run(new Response("<html>bad gateway</html>", { status: 502 }))).toMatchObject({ kind: "server" });
    expect(await run(new Response("{oops", { status: 200 }))).toMatchObject({ kind: "malformed" });
  });

  it("a network failure is transient, an abort a timeout", async () => {
    const down = await geminiGenerate(geminiClient({ apiKey: "k", fetch: fetchOf(() => { throw new TypeError("fetch failed"); }) }), { model: "m", parts: [] }, signal).catch((e) => e);
    expect(down.kind).toBe("network");
    const abort = await geminiGenerate(geminiClient({ apiKey: "k", fetch: fetchOf(() => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }) }), { model: "m", parts: [] }, signal).catch((e) => e);
    expect(abort.kind).toBe("timeout");
  });
});

describe("geminiEmbed", () => {
  it("returns one vector per text and rejects the wrong width", async () => {
    const ok = geminiClient({ apiKey: "k", fetch: fetchOf(() => json({ embedding: { values: [0.6, 0.8] }, usageMetadata: { promptTokenCount: 3 } })) });
    const out = await geminiEmbed(ok, { model: "gemini-embedding-2", texts: ["a", "b"], dimensions: 2 }, signal);
    expect(out.value).toEqual([[0.6, 0.8], [0.6, 0.8]]);
    expect(out.usage.inputTokens).toBe(6);
    await expect(geminiEmbed(ok, { model: "gemini-embedding-2", texts: ["a"], dimensions: 3 }, signal)).rejects.toMatchObject({ kind: "malformed" });
  });
});
