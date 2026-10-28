# ADR 0009: About you from admin config, no onboarding round

Status: accepted (2026-10-28). Roadmap row 5c, onboarding v2. Amends ADR 0006 (rules 2, 7 and 8).

## Context

Row 5 built onboarding as a game: a matchmade Colyseus round of quick-fire bank questions whose coins
waited on the round until sign-up (once per normalised email and device). Keeping those questions
fresh is ongoing operational work, the coins made the first minutes read as money rather than play,
and the timed picks ("why are you here") were fixed in code. The product decision (CLAUDE.md,
Onboarding) is: no coins round, and About you comes from the admin console, one set for people and one
for brands, versioned, never re-asked.

## Decision

1. **The round is gone.** `OnboardingRoom`, its matchmaking and protocol, `onboarding_rounds`,
   `onboarding_devices`, `onboarding_configs`, `GET /onboarding/rewards`, `GET/PUT /admin/onboarding`, the
   reward claim in `becomeMember()` and the seeded starter questions (placeholder embeddings) are
   removed (migration 0012). Sign-in results no longer carry `onboardingBonus`/`bonusKobo`. Signing up
   still pays held Climb awards. No sign-up bonus (open question 5); `normaliseEmail()` stays for when
   there is one.
2. **About you is a versioned config per audience.** `about_configs (audience, version)`: one immutable
   row per admin save, numbered 1, 2, … within the audience; the highest is current. Version 1 is the
   prototype's set, written by migration 0014 (and by `db:seed` if missing), so every database has a
   current version; a read that finds none is an error (`about_config_missing`), never a write.
   The schema (`packages/shared/src/about.ts`) has questions (stable id, prompt, hint, single | multi,
   min/max) and options (stable id, emoji, label, lanes from the category tags, normalised; weights,
   archetype → small integer). It refuses duplicate ids, a min above the option count, unknown
   archetypes, and any weights in the brand set.
3. **One pure function derives the result.** `deriveAbout()`: lanes are every picked option's lanes,
   each once; the archetype is the highest summed weight, ties to the fixed order competitor, host,
   grinder, fan, no weights → competitor; a brand is always host. The API stores it; the admin preview
   (`POST /admin/onboarding/about/:audience/preview`, against the current set or an unsaved draft) runs
   the same function. `ARCHETYPES` stays in code because each one changes what Home leads with.
4. **Answers are stored with their version.** `PATCH /me/onboarding { about: { version, answers } }` is
   checked against that version (every question answered within its range, only its own options) and
   writes `users.about_answers`, `about_version`, `about_audience`, the derived `archetype` and the lanes
   into `interests`. `who` and `about` in one request are one transaction on
   the locked user row: rejected answers leave everything as it was. Any existing version is accepted, so a client that loaded the set just before an
   admin saved still saves. The old `users.why` is dropped.
5. **A new version never reaches back.** Saving a version touches no user. `GET /me/onboarding` returns
   the answers, the current set and a prefill (earlier picks whose question and option ids still
   exist); editing from Me answers the current version. A new question is offered (`hasNewQuestions`),
   never forced.
6. **Switching who's playing** (person ↔ brand) clears the other set's answers and archetype; lanes stay.

## Alternatives considered

- **Keep the config in `app_config` (one mutable row).** Answers would point at a config that has
  since changed; the version is what makes stored answers mean what they meant.
- **Store only the derived lanes and archetype.** Smaller, but Me couldn't prefill, and a scoring
  change could never be explained against what the person actually picked.
- **Re-derive everyone's archetype when the config changes.** Silently moves what Home leads with for
  people who answered nothing new; the agreed rule is never to rewrite existing answers.
- **Option ids as array positions** (the prototype). Reordering or removing an option would change
  what old answers mean; stable ids survive edits.

## Consequences

- An admin can reword an option (same id) and old answers keep pointing at it; removing an option or a
  question leaves old answers intact but unprefillable for that part.
- Recommendations (row 7) read `archetype` and `interests` exactly as before; they gain the raw
  answers and version if a rule needs them.
- Brand onboarding (row 8) adds its checklist after About you; the brand set is already served.
