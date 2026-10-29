# ADR 0011: Climb settings live per stage, per game type, and ramp by round

Status: accepted (Oct 2026). Roadmap 3b, Climb games and settings.

## Context

Climb generators scaled difficulty from one number, the stage's `level` (0 at the first stage, 1 at the
last), with the scales hard-coded per type. Admins couldn't make a type easy in stage 1 and hard in stage
4, couldn't make rounds harder within a stage, and the only time was the stage's seconds, which doesn't fit
games whose length depends on what's in them (pattern recall's show time; word search's words). Two new
types (pattern recall, word search) needed their own knobs.

## Decision

- **Each type declares a settings schema** (zod, with bounds) and level-based defaults, in
  `packages/shared/src/climbSettings.ts`, next to its view and answer shapes, so the console validates and
  totals a draft the same way the server does. The generator in `packages/game` reads the settings; the
  registry is unchanged in shape.
- **A stage holds one settings block per type it allows.** Parsing a ladder fills each block from the
  type's defaults at that stage's level and drops blocks for types the stage doesn't list. A ladder saved
  before settings existed therefore parses to concrete settings that reproduce the old scales, and every
  saved version says exactly how its rounds play. The ladder stays versioned; a run plays its version.
- **Any numeric setting is a number or a ramp `{ first, last }`**, read at the round's index within the
  stage (round 1 is `first`, the stage's last round is `last`, rounded in between). A stage decided early
  just stops climbing. Difficulty depends only on stage and round, never on the player.
- **Time is a setting.** Most types take `seconds` (absent: the stage's seconds). Pattern recall lasts
  its show time plus seconds to repeat; word search lasts seconds per word times the words actually placed.
  The server computes each round's clock when it makes the round and stamps `closes_at` from it; the
  admin summary and Climb home use the same formula for the longest possible round.
- **Words come from the admin list**, loaded per round for the type's word game. Rounds store what they
  accept (word hunt's words in the grid, scramble's listed anagrams) so grading never reads the list and
  list edits never change a round already made.

## Alternatives considered

- **Keep `level` and add per-stage multipliers.** Smaller, but every knob would still be a hidden curve in
  code, and per-round ramps and time-per-unit wouldn't fit.
- **Settings per type, global (not per stage).** Can't make the same type harder later in the ladder.
- **Store only what the admin changed, fill defaults at play.** Saved versions would change meaning
  whenever a default changed in code; filling at parse keeps versions honest once saved (a version saved
  before this ADR is filled from today's defaults, which reproduce the old behaviour).

## Consequences

- Adding a type means a settings schema and defaults as well as the shapes and generator.
- A default changed in code alters only ladders saved before settings existed (version 1 and any
  pre-ADR saves), which re-parse on read; newer saves keep the filled values they were saved with.
- Word supply never stops a run. A round prefers words the player hasn't met in their last 20 runs at the
  stage's lengths; short of those it widens a letter at a time to the nearest lengths that still work
  (what fits the grid; never shorter than word hunt counts); then takes words met before but not in the
  last 3 runs; then any word. Each fallback is logged. Only a game with no usable word on the list at all
  ends the run, as abandoned with its banked points kept (The Climb takes no entry, so nothing is refunded).
- The editor warns when a stage's lengths are thin (runs will widen), and refuses to save (400 at
  `stages.i.settings.<type>`) a stage the list can't supply even at every length that works.
