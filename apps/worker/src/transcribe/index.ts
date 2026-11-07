/**
 * Voice-note transcription, behind a vendor-neutral interface (ADR 0016: Gemini). Selected by TRANSCRIBER
 * (mock | gemini; mock by default); an unknown name, or a real provider without its key, throws rather than
 * falling back to the mock. Adding one = a file implementing Transcriber + a registry entry.
 */
import { Breakers, DEFAULT_BREAKER, DEFAULT_RETRY, geminiClient, withCallContext } from "@contestly/ai";
import { dbBudgetGate, dbUsageSink } from "@contestly/db";
import { PRICED_MODELS, type PricedModel } from "@contestly/shared";
import { geminiTranscriber } from "./gemini.js";
export interface Transcript {
  text: string;
  /** The provider's own measure of the audio, when it gives one. */
  durationMs?: number;
  /** Which provider wrote it, recorded with the transcript. */
  provider: string;
}

export interface Transcriber {
  transcribe(audio: { bytes: Uint8Array; contentType: string }): Promise<Transcript>;
}

/** Stands in until a provider is chosen: deterministic, never pretends to have heard anything. */
export const mockTranscriber: Transcriber = {
  async transcribe({ bytes, contentType }) {
    return { text: `[mock transcript: ${bytes.length} bytes of ${contentType}]`, provider: "mock" };
  },
};

/** Per attempt; a minute of audio transcribes in seconds. */
const TRANSCRIBE_TIMEOUT_MS = 60_000;
export const DEFAULT_TRANSCRIBE_MODEL: PricedModel = "gemini-3.5-transcribe";

function transcribeModel(): PricedModel {
  const name = process.env.GEMINI_TRANSCRIBE_MODEL ?? DEFAULT_TRANSCRIBE_MODEL;
  if (!PRICED_MODELS.includes(name as PricedModel)) throw new Error(`GEMINI_TRANSCRIBE_MODEL=${name} has no price in PROVIDER_PRICES`);
  return name as PricedModel;
}

const transcribers: Record<string, () => Transcriber> = {
  mock: () => mockTranscriber,
  gemini: () => geminiTranscriber({
    client: geminiClient({ apiKey: process.env.GEMINI_API_KEY ?? "" }),
    call: { sink: dbUsageSink, budget: dbBudgetGate, breakers: new Breakers(DEFAULT_BREAKER), retry: DEFAULT_RETRY, timeoutMs: TRANSCRIBE_TIMEOUT_MS },
    model: transcribeModel(),
  }),
};

export function selectTranscriber(name = process.env.TRANSCRIBER ?? "mock"): Transcriber {
  const factory = transcribers[name];
  if (!factory) throw new Error(`TRANSCRIBER=${name} is not a registered provider (have: ${Object.keys(transcribers).join(", ")})`);
  const t = factory();
  // Every call is recorded as part of the transcription job (no party: a voice note's cost is the day's).
  return { transcribe: (audio) => withCallContext({ partyId: null, job: "transcribe_voice" }, () => t.transcribe(audio)) };
}
