/**
 * Voice-note transcription, behind a vendor-neutral interface (the first real provider is open question 2's
 * sibling: see "LLM and transcription providers" in the architecture doc). Selected by TRANSCRIBER; an unknown
 * name throws rather than falling back to the mock. Adding one = a file implementing Transcriber + a registry entry.
 */
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

const transcribers: Record<string, Transcriber> = { mock: mockTranscriber };

export function selectTranscriber(name = process.env.TRANSCRIBER ?? "mock"): Transcriber {
  const t = transcribers[name];
  if (!t) throw new Error(`TRANSCRIBER=${name} is not a registered provider (have: ${Object.keys(transcribers).join(", ")})`);
  return t;
}
