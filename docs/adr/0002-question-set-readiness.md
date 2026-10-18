# ADR 0002: When a sealed set is built, how everyone learns it's ready, and what happens when it isn't

Status: accepted (step 2a, Oct 2026). Revised Oct 2026: sealed sets are built at party creation, not
at start; a failed set no longer cancels the party; start re-checks the set against the roster.

## Context

The first version generated sealed sets at party start: the worker flipped the party to `live` and
enqueued `generate_set`, the room waited, and a failure cancelled and refunded everyone. That made
every start wait on generation, and a bad brief only surfaced as a cancelled party at start time,
when nobody could fix it. CLAUDE.md now says sealed sets are generated as soon as the party is
created; "sealed" means nobody can see the content before start, not that it doesn't exist yet.

Building early creates one new problem: a player who joins after the set was built may already have
played one of its questions in another party. Services never call each other over HTTP, and money
only moves in the worker.

## Decision

- **Build at creation.** `api` enqueues `generate_set` when a sealed party is created (curate: when
  the host asks for drafts). The party carries `questions_status`
  (`not_started` / `generating` / `ready` / `failed`) and `questions_error`, a reason worded for the
  host. Party detail and the room's phase message expose these as `questions: { status, error, … }`,
  never anything from the questions themselves.
- **Durable truth is Postgres; the signal is best-effort.** The questions service persists the set
  (bank rows, generation records, spec summary, status `ready`) in one transaction, then publishes
  `questions_ready` (or `questions_generating` / `questions_failed`) on `party:events`. The room
  re-reads the party on every such event, broadcasts `MSG.questionsStatus` to the lobby, and starts
  the round only when the party is live **and** the set is `ready`. A room created later reads the
  same row.
- **A failed set doesn't cancel.** When `generate_set` exhausts its retries before start, the set is
  marked `failed` with a reason, the host is notified (`questions_failed` on the notify queue), and
  the lobby is told. Joins stay open. The host's team can `POST /parties/:id/questions/retry`,
  optionally changing the brief, difficulty or formats; each retry is a fresh job id.
- **Start re-checks the roster, and is instant when there's nothing to swap.** At start the worker
  runs one query (`seenInSet` in `packages/db`): which of the set's playable questions has anyone
  now seated already been shown? None → the party goes live and the round starts at once. Some →
  the worker marks the set `generating` and enqueues `reseal_for_roster`; the questions service
  replaces only those, in place, from unused reserves, then the bank, then a small generated
  top-up; drops seen reserves; logs each swap (`party_question_events`, kind `replace`, reason
  `seen_by_roster`); marks the set `ready`. A set still being built at start runs the same re-check
  itself before it marks itself ready. "Live" is announced only after the start transaction commits,
  so the room never reads the set's state from before it.
- **Only a live party with nothing to play is cancelled,** through the worker: a re-check (or a
  still-running build) that exhausts its retries becomes `cancel_generation_failed`; a set still
  `failed` at start time cancels and refunds there. Belt-and-braces: the watchdog cancels a live
  party whose set isn't `ready` after `questionsConfig.generationTimeoutSeconds`. The room
  heartbeats from the moment it sees `live`, so waiting is never mistaken for a dead room.
- **One rule for "already seen".** `seenBySeated` in `packages/db` (a player was in the match when the
  bank question ran in another party, answered or not) is used both when building the set and by the
  start-time check.

## Alternatives considered

- **Keep generating at start.** No roster problem, but every start waits on generation and a failure
  can only be handled by cancelling everyone's entry at the last moment.
- **Rebuild the whole set at start.** Simple, but throws away a verified set to fix one question and
  makes every start slow.
- **Block joins by anyone who has seen a question.** Turns a question-bank detail into a reason
  someone can't join their friends' party.
- **Room polls Postgres for readiness.** Every waiting room polls on a timer; the channel already
  exists and the row read on each event is the fallback.

## Consequences

- pgvector is assumed: local dev uses the `pgvector/pgvector:pg16` image with
  `packages/db/init/01-pgvector.sql` creating the extension on a fresh volume. On DO Managed
  Postgres, run `CREATE EXTENSION IF NOT EXISTS vector;` once per database before `db:push`.
- `parties.live_at` exists so the watchdog can measure how long a live party has waited for a ready
  set; don't reuse it as "when the first question opened".
- Parties created before `questions_status` existed are `not_started`; at start the worker builds
  their set then, the old way.
- A file can only be sent once the party exists, so a sealed party built from a file is created
  with `awaitFiles: true`: the API doesn't queue its set, and the questions service queues it when
  the file has been read and indexed (or couldn't be read, which fails the set; the file carries the
  reason). Until then the set shows as `generating`. A file that never arrives leaves it there; at
  start the watchdog's generation timeout cancels and refunds, as for any set still being built.
  A failed set is fixed by sending a new file, which replaces the old one, then retrying; a retry
  while that file is still being indexed is queued once it's done (ADR 0004).
