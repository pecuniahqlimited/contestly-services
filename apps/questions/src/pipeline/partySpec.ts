/** A party's GenerationSpec: its brief and settings, scoped to its parsed source files if it has any. */
import type { Party } from "@contestly/db";
import { partyFileIds } from "./sources.js";
import { buildSpec } from "./spec.js";

export async function specFor(party: Party) {
  return buildSpec({ brief: party.brief, difficulty: party.difficulty, formats: party.formats, questionCount: party.questionCount, questionSeconds: party.questionSeconds, fileIds: await partyFileIds(party.id) });
}
