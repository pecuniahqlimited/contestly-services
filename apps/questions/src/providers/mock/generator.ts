/**
 * Deterministic generator over the fixture deck: filters to the spec's formats, ranks by topic
 * overlap and closeness to the requested difficulty, and always slips in the planted bad
 * questions and the near-duplicate so the verify and dedupe steps have something real to catch.
 */
import type { Difficulty } from "@contestly/shared";
import { BAD_IDS, DECK, DUP_IDS, type DeckEntry } from "./deck.js";
import { draftsFromFile } from "./fromFile.js";
import type { DraftQuestion, Generator } from "../types.js";

const DIFFICULTY_TARGET: Record<Difficulty, number> = { easy: 0.25, mixed: 0.5, hard: 0.7, brutal: 0.85 };
const PLANTED_IDS = new Set<string>([...Object.values(BAD_IDS), DUP_IDS.duplicate]);

const toDraft = (e: DeckEntry): DraftQuestion => ({ format: e.format, payload: e.payload, explanation: e.explanation, claim: e.claim });

export const mockGenerator: Generator = {
  async draft({ spec, count, avoid, sources }) {
    const avoidSet = new Set(avoid);
    if (sources) return spec.formats.includes("pick_one") ? draftsFromFile(sources, count, avoidSet) : [];
    const eligible = (e: DeckEntry) => spec.formats.includes(e.format) && !avoidSet.has(e.payload.question);

    const planted = DECK.filter((e) => PLANTED_IDS.has(e.id)).filter(eligible);
    const target = DIFFICULTY_TARGET[spec.difficulty];
    const topic = spec.topic.toLowerCase();
    const score = (e: DeckEntry) => e.topics.filter((t) => topic.includes(t)).length * 2 - Math.abs(e.difficulty - target);

    const good = DECK.filter((e) => !PLANTED_IDS.has(e.id)).filter(eligible);
    // Stable rank; the duplicate's original always leads so the planted near-duplicate has its pair in the batch.
    good.sort((a, b) => (a.id === DUP_IDS.original ? -1 : b.id === DUP_IDS.original ? 1 : score(b) - score(a) || DECK.indexOf(a) - DECK.indexOf(b)));

    const chosen = good.slice(0, Math.max(0, count - planted.length));
    return [...chosen, ...planted].slice(0, count).map(toDraft);
  },
};
