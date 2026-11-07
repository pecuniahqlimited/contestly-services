# ADR 0015: Party templates and host-authored questions

Status: accepted (5 Nov 2026). Roadmap row 13, brought forward to launch (20 Nov) for personal templates. Amends ADR 0003 (curate drafts).

## Context

Hosts throw parties for occasions: a birthday, a bridal shower, an office party. The best questions for those are about the people in the room ("Where did Tolu and Femi first meet?"), which no engine can generate or check. Today every question comes from the engine and is fact-verified. Templates let a host start from an occasion instead of a blank brief, and add questions only they can write.

## Decision

1. **Templates are data, managed entirely from the admin console.** Nothing about any template is hard-coded: admins **add, edit, reorder, hide and remove** templates without a release, with a preview, every change logged with a reason and versioned like About you. Each template has a name, a one-line pitch, an occasion, a cover, default dials (difficulty, seconds per question, count, formats), a list of **host prompts** and a **themed-question spec** for the engine. The starting set is seed data, not code. A party made from a template keeps its own copy, so editing or removing a template never changes a party already created from it.
2. **At launch: six personal templates.** Birthday, bridal shower, couples' hangout, game night, office party, reunion. Brand templates (product knowledge, product launch, the feedback poll format) follow row 8, after launch.
3. **Picking a template prefills the builder.** In the builder's first scene a host picks a template instead of typing a brief. It prefills the name, brief, cover, dials and a starter set. The host can edit or delete any of it, down to an empty set, and add their own questions to any party, template or not.
4. **Two kinds of question in a set:**
   - **Host-authored:** the host writes the question and the correct answer. The engine suggests three distractors of the same type and length (the host can edit them). Pick-one only at launch. They **skip fact verification** (nothing can check them) but **never the safety filter**, which fails closed. They're marked host-authored, stored with the party only, and **never enter the shared bank**.
   - **Themed:** generated or retrieved from the template's spec through the normal pipeline, with every check.
5. **Any set with a host-authored question runs in curate mode** (ADR 0003): the host reviews the whole set, and the host, the host's team and anyone who saw the drafts can't play. The lobby and game screen say the set includes host-written questions.
6. **Stakes.** Template parties are host-funded or entry-fee (pooled) only, never free (decided Oct 2026).
7. **Anti-collusion, because the host knows every answer.** A friend of the host could be told the answers, so for any party with host-authored questions and money at stake:
   - **Caps** (config): a maximum entry fee and a maximum host-funded cash prize, and host-authored questions can make up at most a set share of the questions (default 50%), so the themed questions still decide most of the game.
   - **A link check at settlement:** a winner is "linked" to the host if they're in the host's people (crew mate, contact, played with recently) or share an install id or IP with the host.
   - **An outlier check:** a linked winner whose host-authored accuracy is far above the room's (config threshold) is flagged.
   - **A flagged prize is held, not paid out:** it's credited but can't be withdrawn until an admin clears it (one admin, with a reason, logged), and a warning alert is raised. A rejected prize goes back into the pot for the next placed player or is refunded, by the rules in the implementation.
   - Free play between friends isn't affected; these rules only apply where money moves.
8. **Host-funded cash prizes** to a linked winner go through the same check, since a host funding a friend's withdrawable win is a way to move money.
9. **Learning:** host-authored questions are excluded from difficulty calibration and the bank's play stats, since they only ever run once.

## Consequences

- The builder gains a template picker and a host-prompt editor (question, correct answer, suggested distractors).
- The questions service gains a distractor-suggestion call (a generation call, then the safety filter) and a template-spec input to set generation.
- Settlement gains the link and outlier checks and a prize-hold state for flagged prizes, using the payments hold machinery rather than a new path.
- Admins get template config with preview, and a queue for held template prizes.

## Not decided here

- Brand templates and the feedback poll format (after row 8).
- Formats beyond pick-one for host-authored questions.
- Whether free template parties should be allowed later (today: never).

## Implementation notes (row 13, built Nov 2026)

**Data.** `party_template_configs` holds one immutable row per admin save of the whole config: the templates (in
picker order; reorder, hide with `hidden`, remove by leaving one out) and the host-written rules (`maxEntryKobo`,
`maxHostPrizeKobo`, `maxHostShareBps` default 5000, `outlierMarginPct` default 30). Version 1 (six templates) is
written by migration 0046 and `db:seed`. A party keeps `parties.template` (id, version, name, occasion, themed
spec) and `parties.host_rules` (the rules when it was made). Host-written questions are `party_questions` rows
with `host_written` (and `host_authored`, so every existing "out of the bank" rule applies); `host_authored` alone
still means a host's edit of a generated question (ADR 0003), which counts for none of the rules here.
`parties.host_question_count` is recomputed from the rows by `syncHostQuestionCount()` after every change.

**The builder.** `GET /party-templates`; `POST /parties` with `template: { id, version }` lays the host's fields
over the template's (`withTemplate`), and `hostQuestions` (pick-one: question, answer, three distractors). Any
host-written question forces curate. `POST /parties/host-questions/distractors` needs no party; the API checks
the host's words, queues `suggest_distractors` and waits (15 s) for the questions service, which checks them
again, makes one `Generator.distract()` call and filters every candidate through the safety filter (failing
closed: fewer than three safe is an error, never a short list). `POST/PUT/DELETE /parties/:id/host-questions`
while a curate party is open and not generating. Before the engine has drafted the rest, an added question takes a
themed slot and a removed one is deleted; after, an added one lengthens the play order and a removed one shortens
it (voided, kept for the record, never below 3). A sealed party can't take host-written questions later
(`sealed_party_no_host_questions`): its host is seated and may have paid.

**Generation.** `generate_set` makes `questionCount − hostWritten` plus the reserves and spreads the host's
questions through the play order (`hostSlots`). A template's themed spec adds its audience, tone and exclusions.
`record_play` skips host-authored rows explicitly.

**Stakes** (`checkHostWrittenStakes`, with `checkStakes`): a template party is never free even with no host-written
questions; one with host-written questions is never free, and its entry, the host's cash prize, the most its pot can
reach (`potCapKobo`: every seat's entry plus the host's cash prize, under `maxPotKobo`, default ₦50,000) and the
host's share stay under the caps, at creation and at every add (`host_written_pot_above_cap`). The entry cap alone
let 200 seats at ₦1,000 make a ₦200,000 pot.

**The settlement check** (`holdFlaggedPrizes`, in the settle transaction, after prizes are posted): only for
parties with host-written questions, only cash prizes (goods move no money).

- *Linked* reads the raw relationships, never `yourPeople()` (which drops blocked pairs, so a host could block a
  friend before the party to dodge the link): crew mates in a live crew (`crew`), contacts either way (`contact`),
  played together within `yourPeopleDays` before the party (`played_with`), an account younger than
  `newAccountDays` (default 14) that came in through the host's invite to this party or signed up from the host's
  invite (`invited_new`: a second account the host brought in), an install id seen on both accounts (`install`),
  and an IP both used around the party (`ip`): between `ipWindowHoursBefore` (default 24) hours before it and its
  end, and used then by no more than `maxAccountsPerIp` (default 5) accounts, since more is a carrier's shared
  address. "Used" is the signal's first-seen..last-seen span overlapping the window; `user_signals.last_seen_at`
  (migration 0049, backfilled from first seen) is re-stamped at most every 10 minutes per account and address. Each is a link like the others: it holds a prize only with an outlier score. A block either way made within `recentBlockDays` (host-written rules, default 7)
  before the party, or since, is a link itself (`recent_block`); an older block hides nothing, since the other
  relationships are still read through it. "The party" is when it went live (else its start time). A block lifted
  before settlement leaves no row to see.
- *Flagged*: linked, and the winner's mean correctness at least `outlierMarginPct` points above everyone else
  seated on either of two comparisons (`reviewPrize` in packages/game): the host-written questions (when at least
  one was played), or the whole set, because a curate host has seen every generated answer too (ADR 0003). The
  evidence carries both comparisons and which one tripped (`flaggedOn`).
- *Repeats*, across parties: a winner who has already won `repeatWinsMax` (default 2) of the same host's finished
  host-written parties within `repeatWindowDays` (default 30) before this one has the prize held whatever they
  scored and whether or not they're linked (`flaggedOn: ["repeat"]`, `priorWins` in the evidence). A win is a prize,
  held or cleared; a rejected one isn't. It catches what a single party can't: one host feeding the same friend
  across many small parties under the caps.

Each prize is decided before it's paid (`payCashPrizes`, shared by settlement and a reject's pass-on). A flagged
prize is credited into the winner's **`prize_hold`** ledger account (a per-person platform account, like
`contradiction_hold`; `ledger.prizeHoldAccount()`), keyed `party_prize:<party>:<user>` like any prize, so a prize is
paid once, one way. A `held_prizes` row and a `templates.prize_held` warning alert commit with it. Settlement takes
ADR 0013's lock order: the seated players' and the host's `users` rows first, then the party row, then the ledger.

**The hold.** Money in `prize_hold` isn't cash: it can't be withdrawn, spent on an entry or a host's prize, or used
to repay a debt (repay-first only acts on cash credits). The person's withdrawals also wait while a prize of theirs
is held (`withdrawContext()` reports `prizeUnderReview`, `withdrawBlockReason()` answers `prize_under_review`, so the
request, its recheck, the send-time recheck and `GET /me` all say so), and an account with a held prize can't be
deleted (`payment_issue`). The invariant `prize_hold` (payments' `findBreaches`) checks each person's hold balance
equals their open held prizes, and the account is in `PLATFORM_AT_LEAST_ZERO`. Migration 0048 adds the account kind.

**Clear and reject** (`/admin/party-templates/held-prizes`, a reason, `admin_actions`). Neither may be done by the
host or the winner (403 `own_transaction`; for a reject too, since rejecting a host-funded prize can return it to
the host). Clear moves the hold into cash with one journal (`held_prize_clear:<id>`), through `ledger.journal()`, so what the
person owes is repaid from it first, as from any credit. It loosens a payments control, so it follows ADR 0013's maker-checker: below
the payments config's `finalize.secondAdminThresholdKobo` one admin clears; at or above it, the first admin's clear
is a request (`clear_requested_by_user_id`, the prize stays held, `awaitingSecondAdmin`), the same admin asking
again is a replay, and a different admin's clear confirms it; both steps are logged. A reject needs one admin
(it tightens). **Reject, the rule:** the prize is taken back from the winner into the party's pot
(`held_prize_reject:<id>`), then

1. passed to the best-ranked seat that is signed up, not banned, has no prize from this party and wasn't rejected
   before, keyed `party_prize:<party>:<user>` like settlement's own prizes; that player goes through the same check
   and may be held in turn;
2. with nobody to pass it to, a host's cash prize goes back to the host (`held_prize_returned_to_host:<id>:<user>`);
   a pooled prize is refunded evenly to the other seats, the remainder to the best-ranked
   (`held_prize_refunded:<id>:<user>`);
3. with no other seat at all, forfeited to the treasury.

The take-back comes out of the winner's hold, never their cash, so it always covers the prize. The held row is
locked; a second reject answers the first (`replayed`), a clear after a reject (or the other way) is 409
`prize_already_decided`. Lock order (ADR 0013): the people's `users` rows (planned before locking, then
re-planned under the locks; a different plan is 409 `party_changed_try_again`), the party and the held row, then
the ledger.

**Changed before review.** Three points first built differently: the outlier check compared host-written
questions only (now the whole set as well); the link used `yourPeople()` (now the raw relationships and recent
blocks); and a clear was one admin whatever the amount, as Decision 7 reads (now ADR 0013's maker-checker, which
this note supersedes for clearing). Still open: the seeded set is six templates as decided here; the roadmap row
listed five (no Reunion).
