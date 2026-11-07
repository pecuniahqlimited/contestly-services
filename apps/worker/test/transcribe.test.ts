/** The Gemini transcriber against mocked HTTP (ADR 0016): success, empty audio, timeout, rate limit, open circuit. */
import { describe, expect, it } from "vitest";
import { Breakers, geminiClient, MemorySink, noBudget, type CallDeps } from "@contestly/ai";
import { geminiTranscriber } from "../src/transcribe/gemini.js";
import { selectTranscriber } from "../src/transcribe/index.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const deps = (over: Partial<CallDeps> = {}): CallDeps & { sink: MemorySink } => ({
  sink: new MemorySink(), budget: noBudget, breakers: new Breakers({ failureThreshold: 3, cooldownMs: 60_000 }),
  retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, timeoutMs: 100, sleep: async () => {}, log: () => {}, ...over,
}) as CallDeps & { sink: MemorySink };
const transcriber = (h: (body: Record<string, unknown>) => Response | Promise<Response>, d = deps()) =>
  geminiTranscriber({ client: geminiClient({ apiKey: "g", fetch: (async (_u: unknown, init?: RequestInit) => h(JSON.parse(String(init?.body)))) as typeof fetch }), call: d, model: "gemini-3.5-transcribe" });
const audio = { bytes: new Uint8Array([1, 2, 3]), contentType: "audio/mp4" };

describe("Gemini transcriber", () => {
  it("sends the audio inline and measures its length from the audio tokens", async () => {
    let body: Record<string, unknown> = {};
    const d = deps();
    const out = await transcriber((b) => {
      body = b;
      return json({ candidates: [{ content: { parts: [{ text: " How far, see you at 7 " }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 340, candidatesTokenCount: 8, promptTokensDetails: [{ modality: "TEXT", tokenCount: 20 }, { modality: "AUDIO", tokenCount: 320 }] } });
    }, d).transcribe(audio);
    expect(out).toEqual({ text: "How far, see you at 7", provider: "gemini:gemini-3.5-transcribe", durationMs: 10_000 });
    const part = (body.contents as { parts: { inlineData?: { mimeType: string; data: string } }[] }[])[0].parts[1].inlineData!;
    expect(part).toEqual({ mimeType: "audio/m4a", data: Buffer.from([1, 2, 3]).toString("base64") });
    expect(d.sink.records[0]).toMatchObject({ step: "transcribe", outcome: "ok" });
  });

  it("silence is an empty transcript, not an error", async () => {
    const out = await transcriber(() => json({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] })).transcribe(audio);
    expect(out.text).toBe("");
  });

  it("a timeout, a rate limit and an open circuit fail the job (the queue retries it)", async () => {
    await expect(transcriber(() => new Promise<Response>(() => {})).transcribe(audio)).rejects.toMatchObject({ kind: "timeout" });
    await expect(transcriber(() => json({ error: { message: "quota" } }, 429)).transcribe(audio)).rejects.toMatchObject({ kind: "rate_limited" });
    let calls = 0;
    const t = transcriber(() => { calls++; return json({ error: { message: "down" } }, 500); }, deps({ retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } }));
    for (let i = 0; i < 3; i++) await t.transcribe(audio).catch(() => {});
    await expect(t.transcribe(audio)).rejects.toMatchObject({ kind: "circuit_open" });
    expect(calls).toBe(3);
  });

  it("selection: mock by default, unknown names refused, gemini needs its key", () => {
    expect(selectTranscriber("mock")).toBeTruthy();
    expect(() => selectTranscriber("whisper")).toThrow(/not a registered provider/);
    const key = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect(() => selectTranscriber("gemini")).toThrow(/GEMINI_API_KEY/);
    if (key !== undefined) process.env.GEMINI_API_KEY = key;
  });
});
