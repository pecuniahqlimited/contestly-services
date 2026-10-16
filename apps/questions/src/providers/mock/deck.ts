/**
 * The fixture deck behind the mock providers: hand-written, Nigeria-grounded content across all
 * five formats and difficulty bands (it absorbs the old packages/game fixture bank). Deterministic
 * by construction so unit tests and the party sim can assert against it.
 *
 * Planted on purpose, keyed by the BAD_IDS below so MockVerifier and the sim agree on them:
 *   - a question with two correct answers            → verifier "fail"
 *   - a question whose answer is in the question     → verifier "fail"
 *   - a question resting on an unverifiable claim    → verifier "needs_source"
 * plus one near-duplicate pair (dup-capital-a/b) whose wording is close enough that the mock
 * embedder's cosine similarity trips the dedupe step.
 */
import type { QuestionFormat } from "@contestly/shared";

export interface DeckEntry {
  /** Stable fixture id — not the id questions get in the bank or a party. */
  id: string;
  format: QuestionFormat;
  payload: Record<string, unknown> & { question: string };
  explanation?: string;
  /** The factual claim the verifier checks. */
  claim: string;
  /** 0 (everyone gets it) … 1 (nobody does). */
  difficulty: number;
  /** Lowercase keywords matched against the spec's topic. */
  topics: string[];
}

export const BAD_IDS = {
  twoCorrect: "bad-two-correct",
  answerInQuestion: "bad-answer-in-question",
  unverifiable: "bad-unverifiable",
} as const;

export const DUP_IDS = { original: "dup-capital-a", duplicate: "dup-capital-b" } as const;

const pickOne = (id: string, difficulty: number, topics: string[], question: string, options: string[], correctIndex: number, claim: string, explanation?: string): DeckEntry =>
  ({ id, format: "pick_one", payload: { question, options, correctIndex }, claim, difficulty, topics, explanation });

export const DECK: DeckEntry[] = [
  // ---- pick_one -----------------------------------------------------------------------
  pickOne(DUP_IDS.original, 0.15, ["geography", "cities", "general"], "Which city is the capital of Nigeria?", ["Lagos", "Abuja", "Kano", "Ibadan"], 1, "Abuja is the capital of Nigeria.", "Abuja replaced Lagos as the capital in 1991."),
  pickOne(DUP_IDS.duplicate, 0.15, ["geography", "cities", "general"], "Which city is the capital city of Nigeria?", ["Lagos", "Abuja", "Kano", "Ibadan"], 1, "Abuja is the capital of Nigeria."),
  pickOne("po-lga", 0.7, ["general", "geography"], "How many local government areas does Nigeria have?", ["360", "774", "569", "812"], 1, "Nigeria has 774 local government areas.", "774 LGAs across the 36 states and the FCT."),
  pickOne("po-keshi", 0.5, ["football", "sport"], "The Super Eagles won the Africa Cup of Nations in 2013 under which coach?", ["Stephen Keshi", "Clemens Westerhof", "Austin Eguavoen", "Gernot Rohr"], 0, "Stephen Keshi coached Nigeria to the 2013 AFCON title.", "Keshi won it as a player in 1994 and as coach in 2013."),
  pickOne("po-ngn", 0.2, ["general", "money"], "What is the ISO currency code for the Nigerian naira?", ["NGA", "NGN", "NRN", "NAI"], 1, "NGN is the ISO 4217 code for the Nigerian naira."),
  pickOne("po-achebe", 0.25, ["general", "books", "history"], "Who wrote the novel \"Things Fall Apart\"?", ["Wole Soyinka", "Chinua Achebe", "Chimamanda Ngozi Adichie", "Ben Okri"], 1, "Chinua Achebe wrote Things Fall Apart (1958)."),
  pickOne("po-independence", 0.2, ["history", "general"], "In which year did Nigeria gain independence?", ["1957", "1960", "1963", "1966"], 1, "Nigeria gained independence from Britain on 1 October 1960."),
  pickOne("po-lagos", 0.15, ["geography", "cities", "general"], "Which is Nigeria's most populous city?", ["Abuja", "Kano", "Lagos", "Port Harcourt"], 2, "Lagos is Nigeria's most populous city."),
  pickOne("po-lokoja", 0.55, ["geography", "general"], "Which river joins the Niger at Lokoja?", ["Benue", "Ogun", "Kaduna", "Cross"], 0, "The Benue river meets the Niger at Lokoja."),
  pickOne("po-soyinka", 0.45, ["general", "books", "history"], "Which Nigerian won the Nobel Prize in Literature?", ["Chinua Achebe", "Wole Soyinka", "Ben Okri", "Cyprian Ekwensi"], 1, "Wole Soyinka won the Nobel Prize in Literature in 1986."),
  pickOne("po-official-language", 0.1, ["general"], "What is the official language of Nigeria?", ["Hausa", "Yoruba", "English", "Igbo"], 2, "English is the official language of Nigeria."),
  pickOne("po-essence", 0.4, ["music", "afrobeats"], "\"Essence\" featuring Tems is a hit by which artist?", ["Davido", "Wizkid", "Burna Boy", "Olamide"], 1, "Essence (feat. Tems) is a Wizkid song from Made in Lagos (2020)."),

  // ---- pick_all -----------------------------------------------------------------------
  { id: "pa-states", format: "pick_all", difficulty: 0.25, topics: ["geography", "general"], payload: { question: "Which of these are Nigerian states?", options: ["Kwara", "Accra", "Ekiti", "Lomé"], correctIndexes: [0, 2] }, claim: "Kwara and Ekiti are Nigerian states; Accra and Lomé are the capitals of Ghana and Togo.", explanation: "Accra and Lomé are the capitals of Ghana and Togo." },
  { id: "pa-artists", format: "pick_all", difficulty: 0.3, topics: ["music", "afrobeats"], payload: { question: "Which of these artists are from Nigeria?", options: ["Burna Boy", "Black Coffee", "Tems", "Diamond Platnumz"], correctIndexes: [0, 2] }, claim: "Burna Boy and Tems are Nigerian; Black Coffee is South African and Diamond Platnumz is Tanzanian.", explanation: "Black Coffee is South African, Diamond Platnumz is Tanzanian." },
  { id: "pa-oil", format: "pick_all", difficulty: 0.55, topics: ["geography", "general"], payload: { question: "Which of these are major oil-producing states?", options: ["Rivers", "Kano", "Delta", "Sokoto"], correctIndexes: [0, 2] }, claim: "Rivers and Delta are major oil-producing states in the Niger Delta." },
  { id: "pa-afcon", format: "pick_all", difficulty: 0.7, topics: ["football", "sport"], payload: { question: "In which of these years did Nigeria win the AFCON?", options: ["1980", "1994", "2006", "2013"], correctIndexes: [0, 1, 3] }, claim: "Nigeria won the Africa Cup of Nations in 1980, 1994 and 2013.", explanation: "2006 ended in a third-place finish." },
  { id: "pa-borders", format: "pick_all", difficulty: 0.35, topics: ["geography", "general"], payload: { question: "Which of these countries share a land border with Nigeria?", options: ["Benin", "Ghana", "Niger", "Kenya"], correctIndexes: [0, 2] }, claim: "Nigeria borders Benin, Niger, Chad and Cameroon; Ghana and Kenya do not touch it." },
  { id: "pa-nollywood", format: "pick_all", difficulty: 0.3, topics: ["nollywood", "film"], payload: { question: "Which of these are Nollywood actors?", options: ["Genevieve Nnaji", "Lupita Nyong'o", "Richard Mofe-Damijo", "Trevor Noah"], correctIndexes: [0, 2] }, claim: "Genevieve Nnaji and Richard Mofe-Damijo are Nollywood actors." },
  { id: "pa-cassava", format: "pick_all", difficulty: 0.45, topics: ["food"], payload: { question: "Which of these foods are made from cassava?", options: ["Garri", "Suya", "Fufu", "Moi moi"], correctIndexes: [0, 2] }, claim: "Garri and fufu are cassava products; suya is grilled meat and moi moi is made from beans." },

  // ---- order --------------------------------------------------------------------------
  { id: "or-heads", format: "order", difficulty: 0.75, topics: ["history", "general"], payload: { question: "Put these Nigerian heads of state in order, earliest first.", items: ["Olusegun Obasanjo (civilian)", "Nnamdi Azikiwe", "Muhammadu Buhari (civilian)", "Goodluck Jonathan"], correctOrder: [1, 0, 3, 2] }, claim: "Azikiwe led from 1963, Obasanjo (civilian) from 1999, Jonathan from 2010 and Buhari (civilian) from 2015.", explanation: "Azikiwe (1963), Obasanjo (1999), Jonathan (2010), Buhari (2015)." },
  { id: "or-cities", format: "order", difficulty: 0.5, topics: ["geography", "cities"], payload: { question: "Order these Nigerian cities from north to south.", items: ["Port Harcourt", "Kano", "Abuja", "Enugu"], correctOrder: [1, 2, 3, 0] }, claim: "From north to south: Kano, Abuja, Enugu, Port Harcourt.", explanation: "Kano, then Abuja in the middle belt, Enugu, and Port Harcourt on the coast." },
  { id: "or-milestones", format: "order", difficulty: 0.55, topics: ["history", "general"], payload: { question: "Order these milestones, earliest first.", items: ["End of the civil war", "Amalgamation", "Independence", "First republic"], correctOrder: [1, 2, 3, 0] }, claim: "Amalgamation 1914, independence 1960, first republic 1963, civil war ended 1970." },
  { id: "or-notes", format: "order", difficulty: 0.2, topics: ["general", "money"], payload: { question: "Order these naira notes from smallest to largest.", items: ["₦500", "₦5", "₦1000", "₦50"], correctOrder: [1, 3, 0, 2] }, claim: "₦5 < ₦50 < ₦500 < ₦1000." },
  { id: "or-area", format: "order", difficulty: 0.8, topics: ["geography"], payload: { question: "Order these states by land area, largest first.", items: ["Lagos", "Niger", "Taraba", "Borno"], correctOrder: [1, 3, 2, 0] }, claim: "By land area: Niger, then Borno, then Taraba; Lagos is Nigeria's smallest state by area." },
  { id: "or-presidents", format: "order", difficulty: 0.45, topics: ["history", "general"], payload: { question: "Order these fourth-republic presidents, earliest first.", items: ["Goodluck Jonathan", "Olusegun Obasanjo", "Muhammadu Buhari", "Umaru Yar'Adua"], correctOrder: [1, 3, 0, 2] }, claim: "Fourth republic order: Obasanjo, Yar'Adua, Jonathan, Buhari." },
  { id: "or-capitals", format: "order", difficulty: 0.3, topics: ["geography", "cities"], payload: { question: "Put these state capitals in alphabetical order.", items: ["Calabar", "Abeokuta", "Damaturu", "Benin City"], correctOrder: [1, 3, 0, 2] }, claim: "Alphabetically: Abeokuta, Benin City, Calabar, Damaturu." },

  // ---- match --------------------------------------------------------------------------
  { id: "ma-dishes", format: "match", difficulty: 0.5, topics: ["food"], payload: { question: "Match the dish to where it's most associated.", left: ["Banga soup", "Tuwo shinkafa", "Amala"], right: ["Ibadan", "Delta", "Kano"], pairs: [1, 2, 0] }, claim: "Banga soup is a Delta dish, tuwo shinkafa is northern, and amala is associated with Ibadan.", explanation: "Banga is Delta, tuwo shinkafa is northern, amala is Ibadan's pride." },
  { id: "ma-nicknames", format: "match", difficulty: 0.5, topics: ["geography", "cities"], payload: { question: "Match the nickname to the city.", left: ["Centre of Excellence", "Coal City", "Pyramid City"], right: ["Kano", "Lagos", "Enugu"], pairs: [1, 2, 0] }, claim: "Lagos is the Centre of Excellence, Enugu the Coal City, Kano the Pyramid City.", explanation: "Lagos, Enugu and Kano, in that order." },
  { id: "ma-capitals", format: "match", difficulty: 0.3, topics: ["geography", "general"], payload: { question: "Match the state to its capital.", left: ["Oyo", "Rivers", "Plateau"], right: ["Jos", "Ibadan", "Port Harcourt"], pairs: [1, 2, 0] }, claim: "Ibadan is Oyo's capital, Port Harcourt is Rivers', Jos is Plateau's." },
  { id: "ma-hits", format: "match", difficulty: 0.45, topics: ["music", "afrobeats"], payload: { question: "Match the artist to the hit.", left: ["Davido", "Rema", "Wizkid"], right: ["Calm Down", "Essence", "Fall"], pairs: [2, 0, 1] }, claim: "Fall is Davido's, Calm Down is Rema's, Essence is Wizkid's." },
  { id: "ma-languages", format: "match", difficulty: 0.25, topics: ["general", "geography"], payload: { question: "Match the language to the region it's most spoken in.", left: ["Hausa", "Igbo", "Yoruba"], right: ["Southwest", "North", "Southeast"], pairs: [1, 2, 0] }, claim: "Hausa dominates the north, Igbo the southeast, Yoruba the southwest." },
  { id: "ma-landmarks", format: "match", difficulty: 0.7, topics: ["geography", "general"], payload: { question: "Match the landmark to its state.", left: ["Zuma Rock", "Olumo Rock", "Obudu Plateau"], right: ["Ogun", "Cross River", "Niger"], pairs: [2, 0, 1] }, claim: "Zuma Rock is in Niger state, Olumo Rock in Ogun, Obudu in Cross River." },
  { id: "ma-festivals", format: "match", difficulty: 0.75, topics: ["general", "history"], payload: { question: "Match the festival to its home.", left: ["Eyo", "Argungu", "Osun-Osogbo"], right: ["Kebbi", "Osun", "Lagos"], pairs: [2, 0, 1] }, claim: "Eyo is a Lagos festival, Argungu is Kebbi's fishing festival, Osun-Osogbo is held in Osun." },

  // ---- picture ------------------------------------------------------------------------
  { id: "pi-zuma", format: "picture", difficulty: 0.3, topics: ["geography", "general"], payload: { question: "Which landmark is shown in this picture?", imageUrl: "pool/zuma-rock.jpg", imageAlt: "A huge single dome-shaped rock rising out of flat green countryside", options: ["Olumo Rock", "Zuma Rock", "Aso Rock", "Riyom Rocks"], correctIndex: 1 }, claim: "The pictured dome-shaped monolith north of Abuja is Zuma Rock.", explanation: "Zuma Rock, just north of Abuja, appears on the 100 naira note." },
  { id: "pi-flag", format: "picture", difficulty: 0.1, topics: ["general"], payload: { question: "Whose flag is this?", imageUrl: "pool/nigeria-flag.jpg", imageAlt: "A flag of three vertical bands: green, white, green", options: ["Ghana", "Nigeria", "Senegal", "Cameroon"], correctIndex: 1 }, claim: "The green-white-green vertical triband is the flag of Nigeria." },
  { id: "pi-map", format: "picture", difficulty: 0.25, topics: ["geography"], payload: { question: "Which country's outline is this?", imageUrl: "pool/nigeria-outline.jpg", imageAlt: "The borders of a West African country, roughly square with a southern coastline", options: ["Niger", "Ghana", "Nigeria", "Chad"], correctIndex: 2 }, claim: "The pictured outline is the map of Nigeria." },
  { id: "pi-theatre", format: "picture", difficulty: 0.55, topics: ["general", "cities"], payload: { question: "Which building is this?", imageUrl: "pool/national-theatre.jpg", imageAlt: "A large round building with a sloping roof shaped like a military cap", options: ["TBS Lagos", "National Theatre", "Eagle Square", "MKO Stadium"], correctIndex: 1 }, claim: "The cap-shaped building in Iganmu, Lagos is the National Theatre." },
  { id: "pi-aso", format: "picture", difficulty: 0.5, topics: ["general", "geography"], payload: { question: "Which rock formation overlooks Nigeria's seat of government?", imageUrl: "pool/aso-rock.jpg", imageAlt: "A broad granite outcrop rising behind government buildings", options: ["Zuma Rock", "Aso Rock", "Olumo Rock", "Shere Hills"], correctIndex: 1 }, claim: "Aso Rock overlooks the presidential complex in Abuja." },
  { id: "pi-olumo", format: "picture", difficulty: 0.65, topics: ["general", "geography"], payload: { question: "Which landmark is this?", imageUrl: "pool/olumo-rock.jpg", imageAlt: "A rocky outcrop with stairs and viewing platforms built into its side", options: ["Olumo Rock", "Zuma Rock", "Riyom Rocks", "Obudu Plateau"], correctIndex: 0 }, claim: "The pictured outcrop with stairways in Abeokuta is Olumo Rock." },
  { id: "pi-bridge", format: "picture", difficulty: 0.45, topics: ["cities", "general"], payload: { question: "Which bridge is this?", imageUrl: "pool/lekki-ikoyi.jpg", imageAlt: "A white cable-stayed bridge over a lagoon at dusk", options: ["Third Mainland Bridge", "Lekki-Ikoyi Link Bridge", "Niger Bridge", "Carter Bridge"], correctIndex: 1 }, claim: "The white cable-stayed bridge over the Lagos lagoon is the Lekki-Ikoyi Link Bridge." },

  // ---- planted bad questions (see BAD_IDS) ---------------------------------------------
  pickOne(BAD_IDS.twoCorrect, 0.3, ["geography", "cities", "general"], "Which of these cities is in Nigeria?", ["Kano", "Enugu", "Accra", "Lomé"], 0, "Kano is the only Nigerian city among Kano, Enugu, Accra and Lomé."),
  pickOne(BAD_IDS.answerInQuestion, 0.2, ["geography", "general"], "Which rock called Zuma Rock appears on the 100 naira note?", ["Zuma Rock", "Olumo Rock", "Aso Rock", "Riyom Rocks"], 0, "Zuma Rock appears on the 100 naira note."),
  pickOne(BAD_IDS.unverifiable, 0.5, ["food", "general"], "How many grains of rice are in an average pot of party jollof?", ["About 40,000", "About 80,000", "About 120,000", "About 200,000"], 1, "An average pot of party jollof contains about 80,000 grains of rice."),
];

const byQuestion = new Map(DECK.map((e) => [e.payload.question, e]));

/** Look a draft up by its question text — how the mock verifier and the sim recognise deck entries. */
export const deckEntryByQuestion = (question: string): DeckEntry | undefined => byQuestion.get(question);

const badQuestions = new Set(Object.values(BAD_IDS).map((id) => DECK.find((e) => e.id === id)!.payload.question));

/** True when a payload is one of the planted bad questions — these must never reach a room. */
export function isKnownBadQuestion(payload: unknown): boolean {
  const q = (payload as { question?: unknown })?.question;
  return typeof q === "string" && badQuestions.has(q);
}
