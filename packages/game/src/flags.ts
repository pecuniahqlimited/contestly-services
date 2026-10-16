/**
 * Player flags → void. A question is voided once distinct flaggers reach a share of the room,
 * but never on fewer than a floor of flaggers (so two friends can't void a question in a big
 * room, and one person can't in a small one). Both numbers are admin config (app_config "questions").
 */

export interface FlagRule {
  flagThresholdPct: number;
  flagFloorPlayers: number;
}

/** Distinct flaggers needed to void a question in a room of `playerCount`. */
export function flagThreshold(playerCount: number, rule: FlagRule): number {
  return Math.max(rule.flagFloorPlayers, Math.ceil((rule.flagThresholdPct / 100) * playerCount));
}

export const shouldVoid = (flaggers: number, playerCount: number, rule: FlagRule): boolean =>
  flaggers >= flagThreshold(playerCount, rule);
