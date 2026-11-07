/**
 * Voice-note transcription, behind a vendor-neutral interface (ADR 0016: Gemini), chosen by AI_PROFILE like
 * the question engine: mock (the default) never calls anything; free uses gemini-3.5-transcribe on the free
 * tier (counted against its daily quota, refused once spent); paid uses GEMINI_TRANSCRIBE_MODEL as a paid
 * call (refused while AI_PAID_CAP_USD is 0). A real profile without its key throws at start.
 */
import { aiProfileFromEnv, Breakers, DEFAULT_BREAKER, DEFAULT_RETRY, geminiClient, Limiters, withCallContext, type CallDeps } from "@contestly/ai";
import { dbBudgetGate, dbFreeQuota, dbUsageSink } from "@contestly/db";
import { FREE_PROFILE_MODELS, FREE_TIER_LIMITS, PRICED_MODELS, type AiProfile, type PricedModel } from "@contestly/shared";
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

const callDeps = (): CallDeps => ({
  sink: dbUsageSink, budget: dbBudgetGate, freeQuota: dbFreeQuota, limiters: new Limiters((m) => FREE_TIER_LIMITS[m]?.rpm),
  breakers: new Breakers(DEFAULT_BREAKER), retry: DEFAULT_RETRY, timeoutMs: TRANSCRIBE_TIMEOUT_MS,
});
const gemini = () => geminiClient({ apiKey: process.env.GEMINI_API_KEY ?? "" });

const transcribers: Record<AiProfile, () => Transcriber> = {
  mock: () => mockTranscriber,
  free: () => geminiTranscriber({ client: gemini(), call: callDeps(), model: FREE_PROFILE_MODELS.transcribe, tier: "free" }),
  paid: () => geminiTranscriber({ client: gemini(), call: callDeps(), model: transcribeModel(), tier: "paid" }),
};

export function selectTranscriber(profile: AiProfile = aiProfileFromEnv()): Transcriber {
  const factory = transcribers[profile];
  if (!factory) throw new Error(`${profile} is not a profile (have: ${Object.keys(transcribers).join(", ")})`);
  const t = factory();
  // Every call is recorded as part of the transcription job (no party: a voice note's cost is the day's).
  return { transcribe: (audio) => withCallContext({ partyId: null, job: "transcribe_voice" }, () => t.transcribe(audio)) };
}
