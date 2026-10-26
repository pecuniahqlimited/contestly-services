# ADR 0008: Friends and crew boards count Climb points plus party points; crews close weekly

Status: accepted (Oct 2026). Row 6b, social.

## Context

The friends board and crew boards (canvas: crew-board) show each person's week as "Climb 300 · parties
140". The Climb already has points (best run each day plus Today's challenge). Parties had no points:
they have ranks, and some have money. Crews were decided in planning (CLAUDE.md, Crews): private,
invite-only, every member's normal play counts, a weekly champion wears a crown, no coins for goals.

## Decision

- **Party points come only from bragging-rights parties**: entry 0 and no prize of any kind
  (`isBraggingRights()` in shared). A staked or prize party earns none, so the social boards never reward
  money play and never become a way to farm a payout.
- **How many**: `partyPointsFor()`: a finish is worth `partyFinishPoints` (10) plus a place bonus
  (`partyPlacePoints`, 40/20/10 for the top three), only in parties of at least `partyPointsMinPlayers`
  (3), and at most `partyPointsDailyCap` (5) parties a Lagos day count. All in app_config "social".
- **Written at settlement**, in the settle transaction (which runs once per party), into `party_days`
  (user, Lagos day, week, points, parties, wins). Guests and players banned mid-party earn none.
- **Boards are plain Postgres reads.** `socialScores()` sums `climb_days` and `party_days` for the
  people on the board, this week or all time; for the week it also sums the days before today so ▲/▼
  compare with how things stood as today began. `socialBoardRanks()` (packages/game) ranks by total with
  shared ranks for ties. The friends board is you plus the people you follow who have points; a crew
  board lists every member. The Everyone board (Climb only, prizes) is unchanged and stays in Valkey.
- **Crew week close** runs in the worker after the Climb's week close: for each live crew that existed
  during the week, its current members are ranked (total, then Climb points, then who joined first)
  and written once to `climb_week_results` with `scope = 'crew'` and `scope_id` = the crew. First place
  is the champion; the crown shows on their name in that crew for the following week. A week missed
  while the worker was down is closed later (up to four weeks back).
- **Crew records** are computed from the record among current members: best climb (most stages, then
  points, then first there), most crew-party wins (rank 1 in a finished party started from the crew,
  `parties.crew_id`), longest streak (`users.best_streak_days`). A run that climbs further than any
  member ever has posts "New crew record" in the crew's chat.
- **The feed** is `feed_events`, written where things happen (a party finished, a personal-best run,
  a streak milestone) with no money in them. A private party's finish is shown only to people who were in
  it.

## Alternatives considered

- **Points for every party, scaled by place.** Simpler, but a cash party would then also move the
  social boards, and the boards would start to read as "who plays for money most". Rejected.
- **Valkey sorted sets for the friends and crew boards**, like Everyone. Friends and crews are small
  (hundreds, at most 50), and per-viewer sets would have to be rebuilt on every follow; plain queries
  over day rows are enough at launch scale and stay correct by construction.
- **A crew goal with a coin reward** (as drawn on the crew-room canvas). Decided against: no coins for
  crew goals, and no goals in v1.
