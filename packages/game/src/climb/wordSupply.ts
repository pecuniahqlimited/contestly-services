/**
 * Whether the active word list can supply a ladder: for each stage and word game it allows, the round that needs the
 * most words it can't get. Short at the stage's lengths is a warning (runs widen the lengths); short even at every
 * length that works is blocking (the ladder can't be saved). Pure: the caller passes the active list.
 */
import { CLIMB_GAME_LABELS, stageTypes, type ClimbLadder, type ClimbWordEntry, type ClimbWordGame, type ClimbWordWarning } from "@contestly/shared";
import { roundWordNeed, wordGameOf } from "./registry.js";
import type { WordNeed } from "./types.js";

const lengths = (min: number, max: number) => (min === max ? `${min}-letter` : `${min}–${max} letter`);

function message(stage: number, label: string, round: number, need: WordNeed, available: number, availableWidened: number, blocking: boolean) {
  const head = `Stage ${stage}, ${label}: round ${round} needs ${need.needed} ${lengths(need.minLength, need.maxLength)} words; the active list has ${available}.`;
  return blocking
    ? `${head} Even at ${lengths(need.shortest, need.longest)} words it has only ${availableWidened}: add words or change the settings to save.`
    : `${head} Runs will use other lengths or repeat words.`;
}

export function wordWarnings(ladder: ClimbLadder, words: readonly ClimbWordEntry[]): ClimbWordWarning[] {
  const supply = (game: ClimbWordGame, min: number, max: number) => words.filter((w) => w.games.includes(game) && w.word.length >= min && w.word.length <= max).length;
  const warnings: ClimbWordWarning[] = [];
  ladder.stages.forEach((stage, i) => {
    for (const type of stageTypes(ladder, stage)) {
      const game = wordGameOf(type);
      if (!game) continue;
      let worst: { warning: ClimbWordWarning; gap: number } | null = null;
      for (let r = 0; r < stage.rounds; r++) {
        const need = roundWordNeed(stage, type, r)!;
        const available = supply(game, need.minLength, need.maxLength);
        const availableWidened = supply(game, need.shortest, need.longest);
        const blocking = availableWidened < need.needed;
        // Blocking outranks any thin supply; then the bigger shortfall.
        const gap = (blocking ? words.length + 1 : 0) + need.needed - available;
        if (need.needed - available <= 0 || (worst && worst.gap >= gap)) continue;
        const { shortest: _s, longest: _l, ...shown } = need;
        worst = {
          gap,
          warning: { stage: i + 1, type: game, round: r + 1, ...shown, available, availableWidened, blocking, message: message(i + 1, CLIMB_GAME_LABELS[type].label, r + 1, need, available, availableWidened, blocking) },
        };
      }
      if (worst) warnings.push(worst.warning);
    }
  });
  return warnings;
}

/** A ladder's blocking warnings as validation issues at each stage's settings for that type, for a 400. */
export const wordSupplyIssues = (warnings: readonly ClimbWordWarning[], at: (string | number)[] = []) =>
  warnings.filter((w) => w.blocking).map((w) => ({ code: "custom" as const, path: [...at, "stages", w.stage - 1, "settings", w.type], message: w.message }));
