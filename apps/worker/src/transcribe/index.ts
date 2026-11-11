/**
 * Voice-note transcription, behind a vendor-neutral interface (ADR 0016: Gemini), on the AI routing's default
 * profile (a voice note isn't a party), resolved per call under AI_ALLOWED_PROFILES: mock never calls anything;
 * free uses gemini-3.5-transcribe on the free tier (counted against its daily quota, refused once spent); paid
 * uses GEMINI_TRANSCRIBE_MODEL as a paid call (refused while AI_PAID_CAP_USD is 0). A profile that can't be built
 * (its key isn't set) is unavailable, and the job retries.
 */
import { allowedProfilesFromEnv, Breakers, DEFAULT_BREAKER, DEFAULT_RETRY, geminiClient, Limiters, ProviderUnavailable, withCallContext, type CallDeps } from "@contestly/ai";
import { aiRouteFor, dbBudgetGate, dbFreeQuota, dbUsageSink } from "@contestly/db";
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

/** One profile's transcriber on its own (tests). */
export function selectTranscriber(profile: AiProfile): Transcriber {
  const factory = transcribers[profile];
  if (!factory) throw new Error(`${profile} is not a profile (have: ${Object.keys(transcribers).join(", ")})`);
  return factory();
}

/**
 * The default profile's transcriber, routed per call (an admin change applies to the next voice note), each
 * profile's built once. Every call is recorded as part of the transcription job under its route (no party: a
 * voice note's cost is the day's).
 */
export function routedTranscriber(allowed: () => readonly AiProfile[] = allowedProfilesFromEnv): Transcriber {
  const built = new Map<AiProfile, Transcriber>();
  return {
    async transcribe(audio) {
      const { route } = await aiRouteFor(null, allowed());
      if (!route.profile) throw new ProviderUnavailable("auth", "none", "transcribe", "no AI profile is allowed for the default route (AI_ALLOWED_PROFILES)");
      let t = built.get(route.profile);
      if (!t) {
        try {
          t = selectTranscriber(route.profile);
        } catch (err) {
          throw new ProviderUnavailable("auth", "none", "transcribe", `the ${route.profile} profile can't transcribe: ${(err as Error).message}`);
        }
        built.set(route.profile, t);
      }
      const chosen = t;
      return withCallContext({ partyId: null, job: "transcribe_voice", route }, () => chosen.transcribe(audio));
    },
  };
}
