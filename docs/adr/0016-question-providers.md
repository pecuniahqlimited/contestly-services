# ADR 0016: Real question providers — Claude generates, Gemini verifies, embeds, checks and transcribes

Status: accepted (7 Nov 2026). Closes open question 2's provider half. Model ids and prices checked against
the providers' own docs and model lists on 7 Nov 2026.

## Context

The question engine (ADRs 0002, 0003) runs behind four vendor-neutral seams (`Generator`, `Verifier`,
`Embedder`, and the worker's `Transcriber`), all mocks until now. The decision of 7 Nov: Claude writes
questions; Gemini fact-checks them with Google Search, embeds them, and transcribes voice notes. Generation
and verification are deliberately different vendors as well as different calls, so a model never grades
its own homework.

## Decision

**Models (defaults; each step's model is admin config, `questions.providers.models`, from a priced list):**

| Step | Provider · model | Why |
|---|---|---|
| generate | Anthropic `claude-sonnet-5-5`, adaptive thinking, effort `medium` | Half Opus 5.5's price ($2/$10 vs $4/$20 per MTok) for writing that every later step re-checks; Opus 5.5 is one config change away if the eval says Sonnet's distractors or local grounding fall short. Haiku 5.5 is too thin for "plausible distractors of the same type and length". |
| verify (open knowledge) | Google `gemini-3.8-flash` + Google Search grounding, structured output | Current Flash, grounding and JSON output in one call. The cost is the search ($14 per 1,000 search queries after 5,000 free a month), not the tokens. |
| verify (file-scoped) | `gemini-3.8-flash`, no search | Checked against the cited chunk only; the web is the wrong source for "only from this file". |
| safety | `gemini-3.5-flash-lite`, one call per batch | Cheapest current model; a classification task. A different family from the generator, like verification. |
| embed | `gemini-embedding-2` at 1536 dimensions | Current text embedder, normalised at truncated sizes, 8k-token input. 1536 is today's column width, so no vector migration, and stays under pgvector's 2,000-dimension HNSW limit (3072 wouldn't index). Env only (`GEMINI_EMBED_MODEL`): changing it means re-embedding. |
| transcribe | `gemini-3.5-transcribe` | The purpose-built speech-to-text model ($0.003/min). Env (`GEMINI_TRANSCRIBE_MODEL`). |

**Selection.** `QUESTIONS_GENERATOR=anthropic`, `QUESTIONS_VERIFIER=gemini`, `QUESTIONS_EMBEDDER=gemini`,
`QUESTIONS_SAFETY=gemini`, `TRANSCRIBER=gemini`. Mocks stay the default for every one of them, for tests and
for dev without keys; a real provider without its key fails at start, never falls back to a mock.

**One call path for every provider call** (`packages/ai`): budget check → circuit breaker → timeout →
retries with jittered exponential backoff (429, 5xx, timeouts and network errors only; Retry-After honoured)
→ one usage row. Per call we record provider, model, step, party (when there is one), job, tokens in/out
(cached and thinking separately), search queries, latency, estimated cost in micro-USD, and outcome
(`provider_calls`). Prices are a named table in `@contestly/shared` (`PROVIDER_PRICES`), the only place a
price lives; the admin's model pickers can only choose priced models, so every call has a cost. The breaker
is per process and per provider+step: five consecutive failures open it for 60 s, then one trial call.
Keys go in headers, never URLs, and never into logs or errors.

**Generation.** One structured-output call per batch of questions of one format, each format with its own
template (pick one, pick all, order, match, picture): the instructions, a JSON schema, and a mapper to the
game payload. The model gives the answer and the distractors separately and we place the answer and shuffle
(seeded by the question text), so position bias can't leak. The prompt carries every rule from CLAUDE.md's
step 3 and the spec (topic, audience, tone, difficulty, exclusions, register, Nigerian grounding where the
lane is Nigerian). File-scoped specs get only the retrieved chunks and must cite one per question; a draft
citing a chunk it wasn't given is invalid. Picture questions are written only about images in the image pool
(a code list with alt text until a licensed pool exists); a draft naming any other image is invalid, so the
engine never hot-links. The `Generator` interface stays general: the client underneath is a plain
"structured call" so the templates branch's `distract()` is a template and a method, not a new client.

**Verification.** A separate Gemini call per question, never the generator. Verdict
`correct | incorrect | ambiguous | unverifiable`, the answer as found, and the grounding sources (URL and
title) stored in the generation record. Only `correct` with at least one source passes the gate, in both
modes. File-scoped drafts are checked against their cited chunk with no search. Results are cached per
question (`verification_cache`, keyed by a hash of verifier model, format, payload, claim and source text),
so a reseal, a regenerate, an eval re-run or an admin edit that changes nothing pays once.

**Safety.** The term filter in `@contestly/shared` runs first and stays the only check on curate-mode host
edits (they're judged in the API, which calls no provider). Drafts that pass it and verification then go to
the model check for everything in step 7 (profanity, hate, sexual content, real private individuals,
gambling or alcohol promotion, politics unless asked, the brief's exclusions). Fail closed: an unavailable,
malformed or partial answer rejects the draft with the reason recorded.

**Embeddings.** Same width, different space: mock vectors and Gemini vectors can't be compared. Each bank row
and file chunk records the model that embedded it (`embedding_model`, migration 0046; existing rows are
`mock`); retrieval and dedupe only compare rows of the current model. `reembed` is a resumable job (batches of
rows whose model isn't current, re-queued until none are left), queued at start when the embedder is real and
by `npm run questions:reembed`. Before launch (row 12): the HNSW index is per column, so filtering by model is a
post-filter; once every row is on one model the filter matches everything and the index serves as is. A
future model change should re-embed into a new column or a partial index rather than mixing spaces.

**Never block a party, never overspend.** `questions.providers` config: `perPartyCents` (default 150) and
`dailyCents` (default 2,500) across all providers, `alertAtPct` (default 80). A call is refused once the
party's or the day's (Africa/Lagos) recorded spend has reached its cap, so overspend is at most one call. The
day crossing `alertAtPct` raises `ai.budget_near` (warning), the cap `ai.budget_reached` (critical); a party
hitting its cap raises `ai.party_budget` (info). Refused, open-circuit, exhausted-retry and malformed calls
are all "unavailable" to the pipeline: generation stops and the fill falls back to bank-only; if that can't
fill count + reserves, the existing failed-set path runs (ADR 0002: the host is told before start; a live
party is cancelled and refunded by the worker).

**Privacy (for the privacy policy).** Providers receive the host's brief, the derived spec, retrieved file
chunks (only for the party that uploaded the file, only the retrieved ones), question text and answers, and,
for transcription, the voice note's audio. Never a user id, name, handle, email, phone or any other personal
data from our tables; the party id stays on our side in `provider_calls`. Anthropic and Google process these
under their API terms. The Gemini key must belong to a billing-enabled project: Google's unpaid tier may use
prompts to improve its products. Google Search grounding sends the verifier's search queries, written by the
model from the question, to Google Search.

## Alternatives considered

- **Claude for everything.** One vendor, one bill, but the verifier would share the generator's blind spots.
- **Opus 5.5 to generate.** Better on paper; twice the price on the step that's re-checked anyway. Kept as a
  config switch.
- **One verification call per batch.** Cheaper, but one bad question can colour the others' verdicts and the
  sources stop being per question. Per question, cached.
- **gemini-embedding-001 / 3072 dimensions.** 001 needs manual normalisation below 3072; 3072 can't use HNSW.
- **Vendor SDKs everywhere.** Anthropic's TypeScript SDK is used (typed errors, structured output); Gemini is
  plain `fetch` against the REST API, which keeps the adapter small and lets the tests mock HTTP directly.

## Consequences

- Google Search grounding is capped at 1,500 grounded requests a day on Gemini 3 models. Bank reuse and the
  verification cache keep us under it; the daily budget should be set to stop well before it.
- Old generation records keep `pass | fail | needs_source` verdicts; readers accept both shapes.
- The eval (`npm run questions:eval`) writes its report to `docs/engineering/eval/`; it's the baseline any
  model or prompt change has to beat.
