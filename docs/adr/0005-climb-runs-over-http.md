# ADR 0005: Climb runs are played over HTTP, not in a realtime room

Status: accepted (Oct 2026). Row 4, The Climb.

## Context

A Climb run is solo: one player, up to 15 short rounds (the default ladder), each answered once.
Parties use a Colyseus room because many people share one clock and the server pushes beats to
everyone. A run has nobody to push to and nothing to sync; what it needs is the same server
authority: the server makes each round, stamps when it opens and when the answer arrives, keeps the
answer until the round closes, and grades.

## Decision

- **Runs are API endpoints**: `POST /climb/runs` starts one and opens its first round,
  `GET /climb/runs/:id` returns the open round (or when the next one opens), and
  `POST /climb/runs/:id/answer` grades the round and decides the stage. Today's challenge works the
  same way under `/climb/challenge`.
- **The server owns the clock.** Each round is stored with its full payload, `opens_at` and
  `closes_at`. The client gets only the type's public view. An answer counts if it arrives by
  `closes_at` plus a fixed network allowance (`latencyAllowanceMs` in the Climb settings); later is
  graded wrong. One answer per round: the first received is final.
- **The next round is scheduled, not requested.** When a round is decided the server creates the next
  one at once with `opens_at` = now + the reveal pause (longer after a cleared stage) and returns only
  that time; its content is served by `GET` once `opens_at` has passed. The client can't buy time
  between rounds, and can't see a round early.
- **Catch-up instead of timers.** No worker job watches a run. Whenever a run is touched (read,
  answered, or replaced by a new run) the server first marks any round whose clock ran out as missed
  and plays the ladder forward from there. Because every round opens on a schedule, a run's whole
  length is bounded by its ladder (about four minutes by default) whether or not the player stays.
- **Points land on the run's start day**, written to `climb_days`/`climb_weeks` each time a stage is
  cleared, so a player who walks away keeps what they banked. With the bounded run length this means a
  week is final shortly after Sunday 23:59 Lagos; the worker closes it at Monday 00:15.
- One active run per player (a partial unique index). Starting a new run ends the old one as
  `abandoned`, keeping its banked points.

## Alternatives considered

- **A Colyseus room per run.** It gives pushes and reconnection tokens, but costs a stateful
  connection and in-process state per solo player for something HTTP does, and it pins every run to
  one realtime instance. Party rooms keep that cost because they need it.
- **Client-timed rounds.** Simpler, but the client would decide timing, which breaks the
  server-authority rule.
- **A worker timer per round.** Thousands of delayed jobs for what a catch-up on the next request
  settles exactly.

## Consequences

- The app polls nothing: it waits until `nextOpensAt`, then calls `GET`. Network time comes out of the
  player's clock up to the allowance; the allowance is a constant, not measured per client as in
  parties (a follow-up if it proves unfair on slow networks).
- Memory rounds show their sequence for `showMs`; the sequence is in the view by nature, so a player
  who screenshots it can repeat it. That's accepted for a free game with weekly prizes vetted by an
  admin.
