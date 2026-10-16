# ADR 0002: How a room learns its question set is ready — and what happens when it never is

Status: accepted (step 2a, Oct 2026)

## Context

Sealed sets are generated at party start (CLAUDE.md, Question engine): the worker flips the party
to `live` and enqueues `generate_set`; the questions service builds, verifies, dedupes and gates
the set. The Colyseus room needs to know when to start the round, and someone has to clean up —
with refunds — when generation fails. Services never call each other over HTTP, and money only
moves in the worker.

## Decision

- **Durable truth is Postgres.** The questions service persists the gated set into
  `party_questions` (bank rows, generation records and the spec summary in the same transaction),
  then publishes `{partyId, status: "questions_ready"}` on the existing `party:events` channel.
- **The signal is best-effort; the rows are not.** The room treats `questions_ready` exactly like
  `live`: call `startMatch()`, which reads `party_questions`. A room created after the publish
  finds the rows anyway; a replayed `generate_set` job sees the rows and just re-publishes.
- **Failure cancels through the worker.** When `generate_set` exhausts its retries, the questions
  service enqueues `{kind: "cancel_generation_failed"}` on the party queue; the worker refunds and
  cancels through the existing `refundParty` path. Belt-and-braces: the worker's watchdog also
  cancels a `live` party that has no set after `questionsConfig.generationTimeoutSeconds`
  (covers a dead questions process whose job never reaches `failed`). The room heartbeats from
  the moment it sees `live`, so waiting on generation is never mistaken for a dead room.

## Alternatives considered

- **Room polls Postgres.** No new signal, but every waiting room polls on a timer and the first
  question is late by up to one poll interval. The channel publish costs nothing extra — the
  subscription already exists — and polling remains the implicit fallback (any later
  `startMatch()` reads the rows).
- **A reply queue (questions → worker → re-emit "live").** More moving parts for the same
  delivery guarantee, and it makes the worker a relay for a message it doesn't act on.
- **Questions service refunds directly.** Fewer hops on failure, but it breaks "all ledger writes
  live behind the worker's party lifecycle" and gives a second service money-moving power for one
  edge case.

## Consequences

- pgvector is now assumed: local dev uses the `pgvector/pgvector:pg16` image with
  `packages/db/init/01-pgvector.sql` creating the extension on a fresh volume (`docker compose
  down -v` once after pulling this change). On DO Managed Postgres, run
  `CREATE EXTENSION IF NOT EXISTS vector;` once per database before `db:push`.
- `parties.live_at` exists solely so the watchdog can measure generation stall; don't reuse it
  as "when the first question opened".
