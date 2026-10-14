/**
 * Where a party's questions come from. The question engine (apps/questions, roadmap step 2)
 * implements this interface; until then the fixture source below serves seeded sets.
 * Every set carries reserve questions so a flag → void → replace never needs a live generation call.
 */
import { randomUUID } from "node:crypto";
import type { MatchQuestion } from "./round.js";

export interface QuestionSpec {
  partyId: string;
  category: string;
  count: number;
  secondsPerQuestion: number;
}

export interface QuestionSet {
  questions: MatchQuestion[];
  reserves: MatchQuestion[];
}

export interface QuestionSource {
  getSet(spec: QuestionSpec): Promise<QuestionSet>;
}

type Fixture = Omit<MatchQuestion, "id" | "seconds">;

/**
 * A small fixed bank covering all five formats. General-knowledge, Nigeria-grounded, verified by
 * hand — placeholder content until the question engine lands. Order mixes formats deliberately.
 */
const FIXTURES: Fixture[] = [
  {
    format: "pick_one",
    payload: { question: "Which city is Nigeria's capital?", options: ["Lagos", "Abuja", "Kano", "Ibadan"], correctIndex: 1 },
    explanation: "Abuja replaced Lagos as the capital in 1991.",
  },
  {
    format: "pick_all",
    payload: { question: "Which of these are Nigerian states?", options: ["Kwara", "Accra", "Ekiti", "Lomé"], correctIndexes: [0, 2] },
    explanation: "Accra and Lomé are the capitals of Ghana and Togo.",
  },
  {
    format: "order",
    payload: {
      question: "Put these Nigerian heads of state in order, earliest first.",
      items: ["Olusegun Obasanjo (civilian)", "Nnamdi Azikiwe", "Muhammadu Buhari (civilian)", "Goodluck Jonathan"],
      correctOrder: [1, 0, 3, 2],
    },
    explanation: "Azikiwe (1963), Obasanjo (1999), Jonathan (2010), Buhari (2015).",
  },
  {
    format: "match",
    payload: {
      question: "Match the dish to where it's most associated.",
      left: ["Banga soup", "Tuwo shinkafa", "Amala"],
      right: ["Ibadan", "Delta", "Kano"],
      pairs: [1, 2, 0],
    },
    explanation: "Banga is Delta, tuwo shinkafa is northern, amala is Ibadan's pride.",
  },
  {
    format: "picture",
    payload: {
      question: "Which landmark is shown in this picture?",
      imageUrl: "fixtures/zuma-rock.jpg",
      imageAlt: "A huge single dome-shaped rock rising out of flat green countryside",
      options: ["Olumo Rock", "Zuma Rock", "Aso Rock", "Riyom Rocks"],
      correctIndex: 1,
    },
    explanation: "Zuma Rock, just north of Abuja, appears on the 100 naira note.",
  },
  {
    format: "pick_one",
    payload: { question: "The Super Eagles won the Africa Cup of Nations in 2013 under which coach?", options: ["Stephen Keshi", "Clemens Westerhof", "Austin Eguavoen", "Gernot Rohr"], correctIndex: 0 },
    explanation: "Keshi won it as a player in 1994 and as coach in 2013.",
  },
  {
    format: "pick_all",
    payload: { question: "Which of these artists are from Nigeria?", options: ["Burna Boy", "Black Coffee", "Tems", "Diamond Platnumz"], correctIndexes: [0, 2] },
    explanation: "Black Coffee is South African, Diamond Platnumz is Tanzanian.",
  },
  {
    format: "order",
    payload: {
      question: "Order these Nigerian cities from north to south.",
      items: ["Port Harcourt", "Kano", "Abuja", "Enugu"],
      correctOrder: [1, 2, 3, 0],
    },
    explanation: "Kano, then Abuja in the middle belt, Enugu, and Port Harcourt on the coast.",
  },
  {
    format: "match",
    payload: {
      question: "Match the nickname to the city.",
      left: ["Centre of Excellence", "Coal City", "Pyramid City"],
      right: ["Kano", "Lagos", "Enugu"],
      pairs: [1, 2, 0],
    },
    explanation: "Lagos, Enugu and Kano, in that order.",
  },
  {
    format: "pick_one",
    payload: { question: "How many local government areas does Nigeria have?", options: ["360", "774", "569", "812"], correctIndex: 1 },
    explanation: "774 LGAs across the 36 states and the FCT.",
  },
];

/** How many reserve questions ride along with every set, on top of `count`. */
export const RESERVE_COUNT = 2;

/**
 * Test/seed-only source: serves from the fixed bank above, cycling if a party asks for more
 * than the bank holds. Deterministic order so the party sim can assert against it.
 */
export const fixtureQuestionSource: QuestionSource = {
  async getSet(spec: QuestionSpec): Promise<QuestionSet> {
    const pick = (n: number) => Array.from({ length: n }, (_, i) => FIXTURES[i % FIXTURES.length]);
    const toQuestion = (f: Fixture): MatchQuestion => ({ id: randomUUID(), seconds: spec.secondsPerQuestion, ...f });
    const chosen = pick(spec.count + RESERVE_COUNT).map(toQuestion);
    return { questions: chosen.slice(0, spec.count), reserves: chosen.slice(spec.count) };
  },
};
