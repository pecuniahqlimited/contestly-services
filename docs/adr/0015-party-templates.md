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
written by migration 0049 and `db:seed`. A party keeps `parties.template` (id, version, name, occasion, themed
spec) and `parties.host_rules` (the rules when it was made). Host-written questions are `party_questions` rows
with `host_written` (and `host_authored`, so every existing "out of the bank" rule applies); `host_authored` alone
still means a host's edit of a generated question (ADR 0003), which counts for none of the rules here.
`parties.host_question_count` is recomputed from the rows by `syncHostQuestionCount()` after every change.

**Nothing in code at runtime.** Every number in the rules (the caps per host type, the share, both margins,
minimum finished parties, account age, the repeat rule, the IP window and busy threshold, recent-block days) is in
the party template config: versioned, saved with a reason and logged, editable from the console with no release.
The schema has no defaults, so a save states every rule and a stored set is read as written. A party keeps the
copy it was made under; one from before copies existed reads the current config, never code (migration 0055 also
gave those parties a copy). `DEFAULT_PARTY_TEMPLATES` and `DEFAULT_HOST_WRITTEN_RULES` are only version 1
(migration 0049, restated by 0055, and `db:seed`). Templates are read only from the database: the builder's list,
what a template fills in (in the version the builder showed) and the preview.

**The builder.** `GET /party-templates`; `POST /parties` with `template: { id, version }` lays the host's fields
over the template's (`withTemplate`), and `hostQuestions` (pick-one: question, answer, three distractors). Any
host-written question forces curate. `POST /parties/host-questions/distractors` needs no party; the API runs
the term filter on the host's words, queues `suggest_distractors` on its own `distractors` queue (the questions
service runs it on separate workers, `DISTRACTORS_CONCURRENCY` at once, so a host never waits behind a set
generation on the single-file questions queue) and waits (30 s) for it,
which runs the term filter again, makes one `Generator.distract()` call (the real generator under the free and
paid profiles, `drafting/distract.ts`: one structured call through `providerCall`, recorded as a generate step;
the mock's own under the mock profile), runs the term filter on every candidate, then the **model safety check**
(ADR 0016's `SafetyReviewer`) on the host's words and every candidate left, in one call. Everything fails closed:
the model refusing the host's words is `host_text_unsafe` with its reasons, a model check that can't run gives no
suggestions (`distractors_unavailable`), and fewer than three passing is an error, never a short list.

**The model check on saved host-written questions.** The term filter runs in the request (creation, add, edit)
and refuses at once; the model check runs in the questions service, as for a curate host's edits (ADR 0016's
`check_host_edit` and `party_questions.edit_check`), queued once the row commits. A host-written question is a
**draft until its check passes**, then approved (the host wrote it; `checkHostEdit` sets it pending); one that
fails, or whose check can't run (`safety_unavailable`), stays a draft with the reasons in the drafts view, and a
curate party can't start with a draft in its play order (the start gate). An edit makes it a draft again with a
new check; a superseded check's late answer changes nothing. The reviewer is told the question is host-written
(`SafetyBrief.hostWritten`): such questions name the party's own people by design, so `private_individual` is
narrowed to sensitive private details or demeaning someone, and every other reason applies as usual. `POST/PUT/DELETE /parties/:id/host-questions`
while a curate party is open and not generating. Before the engine has drafted the rest, an added question takes a
themed slot and a removed one is deleted; after, an added one lengthens the play order and a removed one shortens
it (voided, kept for the record, never below 3). A sealed party can't take host-written questions later
(`sealed_party_no_host_questions`): its host is seated and may have paid.

**Generation.** `generate_set` makes `questionCount − hostWritten` plus the reserves and spreads the host's
questions through the play order (`hostSlots`). A template's themed spec adds its audience, tone and exclusions.
`record_play` skips host-authored rows explicitly.

**Stakes** (`checkHostWrittenStakes`, with `checkStakes`): a template party is never free even with no host-written
questions; one with host-written questions is never free. **Every curate party** keeps its entry, the host's cash
prize and the most its pot can reach (`potCapKobo`: every seat's entry plus the host's cash prize, under
`maxPotKobo`, default ₦50,000) under the caps (`curate_entry_above_cap`, `curate_prize_above_cap`,
`curate_pot_above_cap`), and the host's share stays under its cap at creation and at every add
(`host_written_share_above_cap`). The entry cap alone let 200 seats at ₦1,000 make a ₦200,000 pot.

**Caps by host type.** The curate caps (entry, host prize, pot) are per host type in config
(`rules.capsByHost`: `person`, `brand`), and `curateHostType()` in packages/db/src/host.ts, next to
`canOfferNonCashPrize()`, is the one place that says which a host gets. Every host is a person today, brands
included, and the brand caps start equal to a person's, so behaviour is unchanged. Row 8 changes that function's
body (a verified brand gets `brand`) and raises the brand caps in config: brands will often run curate parties with
bigger prizes. `GET /party-templates` shows the asker's own caps (`hostType` with them; a person's without a
session). The share cap and the settlement check's thresholds are one set for everyone. Migration 0055 restates
stored rules in this shape (below).

**The settlement check** (`payCashPrizes`, in the settle transaction, deciding each prize before it's paid): for
every curate party, with host-written questions or not, only cash prizes (goods move no money).

**Curate parties without host-written questions** (Nov 2026, from review): a curate host has approved every
generated answer (ADR 0003), so a plain curate party was the easy way around everything here: skip the template,
write nothing, tell a friend the answers. What changes for curate behaviour on main:

1. A curate party with money is refused over the caps at creation (rematches too, which go through the same
   path): pooled entry ≤ `maxEntryKobo` (₦1,000), the host's cash prize ≤ `maxHostPrizeKobo` (₦50,000), the pot
   ≤ `maxPotKobo` (₦50,000). Before, only the party limits applied. A free curate party is unchanged (it isn't
   made "never free"; there's nothing to collude over), and so is a sealed party of any size.
2. Its cash prizes go through the settlement check (links, newcomers, the unlinked threshold, repeats) and a
   flagged one is held in `prize_hold` for two admins, exactly as for a template party.
3. Repeat wins count across the host's curate parties, host-written or not.
4. A winner with a held prize can't delete their account until it's decided (`payment_issue`).

Curate's own rules (drafts, approval, the lockout, the start gate) don't change.

- *Linked* reads the raw relationships, never `yourPeople()` (which drops blocked pairs, so a host could block a
  friend before the party to dodge the link): crew mates in a live crew (`crew`), contacts either way (`contact`),
  played together within `yourPeopleDays` before the party (`played_with`), an account younger than
  `newAccountDays` (default 14) that came in through the host's invite to this party or signed up from the host's
  invite (`invited_new`: a second account the host brought in), an install id seen on both accounts (`install`),
  and an IP both used around the party (`ip`): between `ipWindowHoursBefore` (default 24) hours before it and its
  end, and used then by no more than `maxAccountsPerIp` (default 5) accounts, since more is a carrier's shared
  address. Only signed-up accounts created before the window count towards that number: guest sessions (cheap to
  open, 300 an hour per IP) or accounts made for the party on the same Wi-Fi would otherwise make a household's
  address look like a carrier's and drop the link. "Used" is the signal's first-seen..last-seen span overlapping the window; `user_signals.last_seen_at`
  (migration 0052, backfilled from first seen) is re-stamped at most every 10 minutes per account and address. Each is a link like the others: it holds a prize only with an outlier score. A block either way made within `recentBlockDays` (host-written rules, default 7)
  before the party, or since, is a link itself (`recent_block`); an older block hides nothing, since the other
  relationships are still read through it. "The party" is when it went live (else its start time). A block lifted
  before settlement still counts: unblocking writes a `lifted_blocks` row (who, whom, when it was made, when it
  was lifted; migration 0053) in the same transaction as it deletes the `blocks` row.
- *Newcomers*: a winner whose account is younger than `newAccountDays` (default 14) at the party, or who had
  finished fewer than `minFinishedParties` (default 5) parties before it, invited or not, gets the score checks as
  if linked (`newcomer` and `finishedParties` in the evidence). A fresh account made on another phone for one party,
  joined from the Parties tab over mobile data, has none of the ties above to find.
- *Flagged*: linked or a newcomer, and the winner's mean correctness at least `outlierMarginPct` (default 30) points
  above everyone else seated on either of two comparisons (`reviewPrize` in packages/game): the host-written
  questions (when at least one was played), or the whole set, because a curate host has seen every generated answer
  too (ADR 0003). Anyone at all, linked or not, newcomer or not, at least `unlinkedMarginPct` (default 50; a config
  save refuses it below `outlierMarginPct`) above the room on either comparison is held too. The evidence carries
  both comparisons, both thresholds and which one tripped (`flaggedOn`).
- *Repeats*, across parties: a winner who has already won `repeatWinsMax` (default 2) of the same host's finished
  host-written parties within `repeatWindowDays` (default 30) before this one has the prize held whatever they
  scored and whether or not they're linked (`flaggedOn: ["repeat"]`, `priorWins` in the evidence). A win is a prize,
  held or cleared; a rejected one isn't. It catches what a single party can't: one host feeding the same friend
  across many small parties under the caps.
- *Accepted limit.* The margin is measured against the room's mean, not the runner-up: a friend who knows every
  answer can score just under the margin above the room's mean, still beat the best honest player on speed, and be
  paid; accomplices seated in the room also lift its mean. No rule over one party's scores closes that without
  holding honest strong players. It's accepted, with three backstops: the newcomer rule (an accomplice's account
  needs age and a play history first), the unlinked threshold (a large enough margin holds anyone), and the repeat
  rule (the same winner can take only `repeatWinsMax` of a host's parties in the window). The caps bound what one
  party can pay out.

Each prize is decided before it's paid (`payCashPrizes`, shared by settlement and a reject's pass-on). A flagged
prize is credited into the winner's **`prize_hold`** ledger account (a per-person platform account, like
`contradiction_hold`; `ledger.prizeHoldAccount()`), keyed `party_prize:<party>:<user>` like any prize, so a prize is
paid once, one way. A `held_prizes` row and a `templates.prize_held` warning alert commit with it. Settlement takes
ADR 0013's lock order: the seated players' and the host's `users` rows first, then the party row, then the ledger.

**The hold.** Money in `prize_hold` isn't cash: it can't be withdrawn, spent on an entry or a host's prize, or used
to repay a debt (repay-first only acts on cash credits). The person's own cash is untouched: they can withdraw and
spend it as usual (an earlier build also blocked all their withdrawals while a prize was held; the hold account made
that unnecessary, so it's gone). An account with a held prize can't be deleted (`payment_issue`). The invariant `prize_hold` (payments' `findBreaches`) checks each person's hold balance
equals their open held prizes, and the account is in `PLATFORM_AT_LEAST_ZERO`; `ledger.journal()` itself refuses
to take a prize hold below zero (`HoldOverdrawn`), so a clear or reject of a prize that was never in the hold (rows
from a build before the hold account) fails instead of minting cash. Migration 0051 adds the account kind.

**Clear and reject** (`/admin/party-templates/held-prizes`, a reason, `admin_actions`). No admin with an interest
decides (403 `own_transaction`), neither asking nor confirming: the host (rejecting a host-funded prize can return
it to them), the winner, and anyone in the decision's recipient list, i.e. whoever a reject would pass the prize to
or refund (an admin who played and placed next, or holds a seat). A request whose asker has since become a
recipient (the plan changed) doesn't count: the next ask replaces it. **Every decision takes two admins, whatever the amount** (`twoAdmins`): the first admin's clear or reject
is a request (`requested_decision`, `requested_by_user_id`; the prize stays held, `awaitingSecondAdmin`), the same
admin asking again is a replay, a different admin asking the same confirms it, and asking the other decision
replaces the request (a second admin who disagrees doesn't confirm). Both steps are logged
(`…_requested`, then the decision). ADR 0013's amount threshold isn't used: a pooled prize is the pot less the rake,
always under the pot cap, so a threshold at the cap would never fire. Clear moves the hold into cash with one
journal (`held_prize_clear:<id>`), through `ledger.journal()`, so what the person owes is repaid from it first, as
from any credit. Migration 0054 renames the clear-request columns and marks older requests as clears.
**Reject, the rule:** the prize is taken back from the winner into the party's pot
(`held_prize_reject:<id>`), then

1. passed to the best-ranked seat that is signed up, not banned, has no prize from this party and wasn't rejected
   before, keyed `party_prize:<party>:<user>` like settlement's own prizes; that player goes through the same check
   and may be held in turn;
2. with nobody to pass it to, a host's cash prize goes back to the host (`held_prize_returned_to_host:<id>:<user>`);
   a pooled prize is refunded evenly to the other seats, the remainder to the best-ranked
   (`held_prize_refunded:<id>:<user>`). Banned seats are included, as an unplaceable party refunds them
   (`cancelIfUnplaceable`): it's their entry money coming back, and it lands in a frozen wallet (ADR 0014), so a
   banned accomplice can't move it;
3. with no other seat at all, forfeited to the treasury.

The take-back comes out of the winner's hold, never their cash, so it always covers the prize. The held row is
locked; a second reject answers the first (`replayed`), a clear after a reject (or the other way) is 409
`prize_already_decided`. Lock order (ADR 0013): the people's `users` rows (planned before locking, then
re-planned under the locks; a different plan is 409 `party_changed_try_again`), the party and the held row, then
the ledger.

**Changed before review.** Three points first built differently: the outlier check compared host-written
questions only (now the whole set as well); the link used `yourPeople()` (now the raw relationships and recent
blocks); and a clear was one admin whatever the amount, as Decision 7 reads (then ADR 0013's maker-checker above
its threshold; now two admins for every clear and every reject, which this note supersedes Decision 7 with). Six templates at launch is confirmed (Nov 2026).
