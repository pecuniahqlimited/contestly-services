# ADR 0003: Curate drafts live in party_questions; seeing them is what bars you from playing

Status: accepted (step 2b, Oct 2026)

## Context

In curate mode the host's team reviews every question before the party (approve, edit, swap,
regenerate) and therefore can't play it. Drafts need somewhere to live, review actions need an
audit trail ("who approved"), and "can't play" needs one enforcement rule that holds when step 4
adds brand teams.

## Decision

- **Drafts are `party_questions` rows with status `draft`.** Approving sets `pending`, the same
  status a sealed question has, so the approved set *is* the played set: the room, scoring,
  `record_play` and flag → void → replace need no curate branch. A swapped-out question stays as
  a `voided` reserve rather than being deleted, so its review history survives.
- **Every review action is a `party_question_events` row** (approve, edit, swap, regenerate) with
  the user who did it, in the same log as flags, voids and replacements.
- **Edits are host-authored and stay out of the shared bank** (`source_ref` null). They pass the
  same format validation and safety filter as generated drafts (`checkSafety` lives in
  `@contestly/shared` so the API and the engine run one copy), but nothing verified them
  independently, so they don't seed other parties.
- **Seeing drafts bars you from playing.** Viewing the drafts records a `party_draft_views` row;
  `join` refuses the host's team of a curate party and anyone with a view. The curate host isn't
  seated or charged at creation, and the room only puts seated players in the match, so the host
  can watch without playing. Who counts as the host's team is `isHostTeam()` in the ADR 0001
  helper, which step 4 extends to brand teams.
- **Start fails closed.** The worker starts a curate party only if its whole play order exists
  and every question in it is approved; otherwise it cancels and refunds with a reason.

## Alternatives considered

- **A separate `question_drafts` table, copied into `party_questions` on approval.** Cleaner
  separation, but it adds a copy step at start and a second source of truth for the question a
  player saw versus the one a host approved.
- **Enforce the lockout only in the room.** A barred user could still pay an entry and take a
  seat. Refusing at join keeps money out of it entirely; the room's "only seated players play"
  rule is the backstop.

## Consequences

- Party-question status now has four values (`draft`, `pending`, `played`, `voided`); anything
  that loads a play order must exclude `draft` and `voided`.
- Not yet built: rescuing a "needs a source" draft with a host edit. In curate mode such drafts
  are rejected at the gate like in sealed mode; the host swaps or regenerates instead.
