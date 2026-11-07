/**
 * Voice-note transcription with Gemini (ADR 0016): the audio inline (notes are capped at a minute, far under
 * the request limit), a plain verbatim transcript back. The note's length is measured from the audio tokens
 * Gemini bills (32 a second), so a recorder that understated it is caught. Only the audio goes: no name,
 * handle or thread.
 */
import { geminiGenerate, providerCall, type CallDeps, type GeminiClient } from "@contestly/ai";
import type { CallTier, PricedModel } from "@contestly/shared";
import type { Transcriber } from "./index.js";

/** Gemini bills audio at 32 tokens per second. */
export const AUDIO_TOKENS_PER_SECOND = 32;

/** Our upload types as Gemini names them (an .m4a is an MP4 audio container). */
const MIME: Record<string, string> = { "audio/mp4": "audio/m4a", "audio/aac": "audio/aac", "audio/mpeg": "audio/mpeg", "audio/webm": "audio/webm", "audio/ogg": "audio/ogg" };

const PROMPT = "Transcribe this voice note verbatim, in the language spoken (English, Nigerian Pidgin, Yoruba, Igbo, Hausa or a mix). Output only the words spoken, with no commentary. If there is no speech, output nothing.";

export function geminiTranscriber(deps: { client: GeminiClient; call: CallDeps; model: PricedModel; tier: CallTier }): Transcriber {
  return {
    async transcribe({ bytes, contentType }) {
      const out = await providerCall({ provider: "gemini", model: deps.model, step: "transcribe", tier: deps.tier }, deps.call, async (signal) => {
        const r = await geminiGenerate(deps.client, {
          model: deps.model,
          parts: [{ text: PROMPT }, { inlineData: { mimeType: MIME[contentType] ?? contentType, data: Buffer.from(bytes).toString("base64") } }],
        }, signal);
        return { value: { text: r.value.text.trim(), audioTokens: r.usage.audioInputTokens ?? 0 }, usage: r.usage };
      });
      return {
        text: out.text,
        provider: `gemini:${deps.model}`,
        ...(out.audioTokens ? { durationMs: Math.round((out.audioTokens / AUDIO_TOKENS_PER_SECOND) * 1000) } : {}),
      };
    },
  };
}
