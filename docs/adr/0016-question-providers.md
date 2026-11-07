# ADR 0016: Real question providers — Claude generates; Claude verifies and checks for now; Gemini embeds and transcribes

Status: accepted (7 Nov 2026), amended the same day: without Gemini billing, verification and the safety
check moved to Claude by default (see "Same-vendor verification, for dev and testing"). Closes open question
2's provider half. Model ids and prices checked against the providers' own docs and model lists on 7 Nov 2026.

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
| verify (open knowledge) | Anthropic `claude-opus-5-5` + Anthropic's web search tool (`web_search_20260209`, called directly, at most 3 searches), effort `low`, structured output | A different model from the generator, and the stronger one: the only independent check shouldn't be weaker than what it checks. Haiku 5.5 searches but answers from memory more readily (in a probe it skipped the search). About $0.07 a question (≈13k input tokens of search results, $10 per 1,000 searches); the cache pays it once per question. |
| verify (file-scoped) | `claude-opus-5-5`, no search | Checked against the cited chunk only; the web is the wrong source for "only from this file". |
| safety | Anthropic `claude-haiku-5-5`, one call per batch | The small model: a classification task over a few short questions, at $0.10/$0.50 per MTok. |
| verify, safety (option) | Google `gemini-3.8-flash` + Google Search grounding; `gemini-3.5-flash-lite` | The two-vendor setup, for when the Gemini project has billing: pick the Gemini models in the admin console. Grounding costs $14 per 1,000 queries. |
| embed | `gemini-embedding-2` at 1536 dimensions | Current text embedder, normalised at truncated sizes, 8k-token input. 1536 is today's column width, so no vector migration, and stays under pgvector's 2,000-dimension HNSW limit (3072 wouldn't index). Env only (`GEMINI_EMBED_MODEL`): changing it means re-embedding. |
| transcribe | `gemini-3.5-transcribe` | The purpose-built speech-to-text model ($0.003/min). Env (`GEMINI_TRANSCRIBE_MODEL`). |

**Selection.** `QUESTIONS_GENERATOR=anthropic`, `QUESTIONS_VERIFIER=live`, `QUESTIONS_EMBEDDER=gemini`,
`QUESTIONS_SAFETY=live`, `TRANSCRIBER=gemini`. Mocks stay the default for every one of them, for tests and
for dev without keys; a real provider without its key fails at start, never falls back to a mock. `live`
verification and safety take their vendor from the admin's model for the step, on every call, so moving
between Claude and Gemini is a console change with no restart; a model whose vendor's key isn't set fails
that check closed. (`gemini` and `anthropic` are accepted as old names for `live`.)

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
engine never hot-links. Because the pool is short, a set holds at most a quarter of its questions as
pictures (rounded up), never more than the pool's images, and never one image twice (`pipeline/pictures.ts`):
retrieved bank pictures over the cap are dropped (generation fills the gap with other formats), the
generator is asked for no more pictures than the room left, and its pictures over the cap or repeating an
image are dropped before verification, so none is paid for. The `Generator` interface stays general: the client underneath is a plain
"structured call" so the templates branch's `distract()` is a template and a method, not a new client.

**Verification.** A separate call per question, never the generator's call and never the generator's model
(the config refuses `verify` equal to `generate`), with nothing from generation but the question: one user
turn holding the answer key, the claim and the explanation. Verdict
`correct | incorrect | ambiguous | unverifiable`, the answer as found, and the sources (URL and title) stored
in the generation record. With Claude, the sources are the search results Claude names as supporting its
verdict, kept only if they were among the results it was actually shown, so a remembered or invented URL
never counts; with Gemini, the grounding chunks. Only `correct` with at least one source passes the gate, in both
modes. File-scoped drafts are checked against their cited chunk with no search. Results are cached per
question (`verification_cache`, keyed by a hash of verifier model, format, payload, claim and source text),
so a reseal, a regenerate, an eval re-run or an admin edit that changes nothing pays once.

**Safety.** The term filter in `@contestly/shared` runs first. Drafts that pass it and verification then go to
the model check for everything in step 7 (profanity, hate, sexual content, real private individuals,
gambling or alcohol promotion, politics unless asked, the brief's exclusions). Fail closed: an unavailable,
malformed or partial answer rejects the draft with the reason recorded. **Curate host edits** get the same
model check: the API runs the term filter (refusing at once) and marks the edit `checking`; the questions
service's `check_host_edit` job runs the model and marks it `passed` or `failed` with the reasons
(`party_questions.edit_check`, migration 0047; failed with `safety_unavailable` when the model can't
answer). Only a passed edit can be approved (409 `edit_check_pending`, `edit_failed_safety`); a newer edit
replaces the check, and a regenerate clears it. The API never calls a provider itself.

**Embeddings on Gemini's free tier.** Without billing the project gets 100 embed requests a minute and
**1,000 a day** per model (the 429 names the quota, `EmbedContentRequestsPerMinute…-FreeTier` or
`EmbedContentRequestsPerDay…-FreeTier`, and says when to retry; the day resets at midnight Pacific). Each
text is one request. The embedder spaces them with a per-process limiter
(`GEMINI_EMBED_RPM`, default 90, a margin under 100); a 429 anyway (another process on the same key) waits
the RetryInfo delay, up to six attempts, unless the delay is longer than a retry would wait (the daily quota:
"retry in 20 hours"), which fails the call at once instead. The `reembed` chain treats an unavailable
embedder as "later", not failed: it re-queues itself after a backoff (1 min, doubling, at most 30 min), or
after the quota's own reset when it said one, so a re-embed runs slowly and never stops. Restarting the service doesn't start a second chain alongside a waiting one.

**Embeddings.** Same width, different space: mock vectors and Gemini vectors can't be compared. Each bank row
and file chunk records the model that embedded it (`embedding_model`, migration 0046; existing rows are
`mock`); retrieval and dedupe only compare rows of the current model. `reembed` is a resumable job (batches of
rows whose model isn't current, re-queued until none are left), queued at start when the embedder is real and
by `npm run questions:reembed`. Before launch (row 12): the HNSW index is per column, so filtering by model is a
post-filter; once every row is on one model the filter matches everything and the index serves as is. A
future model change should re-embed into a new column or a partial index rather than mixing spaces.

**Never block a party, never overspend.** `questions.providers` config: `perPartyCents` (default 500: with Claude verifying at about $0.07 a question,
a 20-question set and its quality buffer costs about $3; the first default of 150 cut sets off) and
`dailyCents` (default 2,500) across all providers, `alertAtPct` (default 80). A call is refused once the
party's or the day's (Africa/Lagos) recorded spend has reached its cap, so overspend is at most one call. The
day crossing `alertAtPct` raises `ai.budget_near` (warning), the cap `ai.budget_reached` (critical); a party
hitting its cap raises `ai.party_budget` (info). Refused, open-circuit, exhausted-retry and malformed calls
are all "unavailable" to the pipeline (the party's cap never refuses embeddings, which cost next to nothing
and which the bank-only fallback needs to search the bank; the day's cap does): generation stops and the fill falls back to bank-only; if that can't
fill count + reserves, the existing failed-set path runs (ADR 0002: the host is told before start; a live
party is cancelled and refunded by the worker).

**Privacy (for the privacy policy).** Providers receive the host's brief, the derived spec, retrieved file
chunks (only for the party that uploaded the file, only the retrieved ones), question text and answers, and,
for transcription, the voice note's audio. Never a user id, name, handle, email, phone or any other personal
data from our tables; the party id stays on our side in `provider_calls`. Anthropic and Google process these
under their API terms. The verifier's search queries, written by the model from the question, go to the
search provider (Anthropic's web search; Google Search when Gemini verifies). **Before launch the Gemini key
must belong to a billing-enabled project:** Google's unpaid tier may use prompts to improve its products. In
dev and testing on the free tier, what Gemini sees is the embedding text (question text, briefs, retrieved
chunks from sim and test files) and voice-note audio from test accounts; no real user's content goes to it
until billing is on.

## Same-vendor verification, for dev and testing (amendment, 7 Nov 2026)

There's no Gemini billing for now, and grounding has no free quota. So the default verifier and safety check
are Claude: `claude-opus-5-5` with Anthropic's web search verifies, `claude-haiku-5-5` checks safety. The
generator stays `claude-sonnet-5-5`.

This is weaker independence than two vendors. A different model, a separate call with no shared context, and
web sources the verdict has to point at all help, but two Claude models share training data and habits, so
they're more likely to share a wrong belief, or to find the same wording convincing, than Claude and Gemini
would be. The source rule carries more of the weight here: only `correct` with at least one source it was
shown passes the gate.

So this setup is for dev and testing. **Revisit before launch (row 12):** with Gemini billing on, switch
verify and safety to the Gemini models in the console and compare `npm run questions:eval` reports from both
setups; keep same-vendor verification only if the eval shows it catches as much.

## Alternatives considered

- **Claude for everything.** One vendor, one bill, but the verifier would share the generator's blind spots.
  Adopted for now, for dev and testing only, with a different and stronger model for verification (above).
- **Haiku 5.5 or Sonnet 5 to verify.** Much cheaper, but a weaker or sibling model checking Sonnet 5.5's work
  is the wrong direction for the one independent check. Either is a console switch if cost matters more.
- **Opus 5.5 to generate.** Better on paper; twice the price on the step that's re-checked anyway. Kept as a
  config switch.
- **One verification call per batch.** Cheaper, but one bad question can colour the others' verdicts and the
  sources stop being per question. Per question, cached.
- **gemini-embedding-001 / 3072 dimensions.** 001 needs manual normalisation below 3072; 3072 can't use HNSW.
- **Vendor SDKs everywhere.** Anthropic's TypeScript SDK is used (typed errors, structured output); Gemini is
  plain `fetch` against the REST API, which keeps the adapter small and lets the tests mock HTTP directly.

## Consequences

- Claude verification costs about $0.07 a question, most of it search results as input tokens; the cache, bank
  reuse and the daily cap bound it. Google Search grounding (the Gemini option) is capped at 1,500 grounded
  requests a day on Gemini 3 models.
- The free tier's daily 1,000 embed requests is the binding limit, not the per-minute one. A generated set
  embeds its spec and every draft (about 30–45 requests for a 10-question set with reserves), so the day's
  quota covers about 20–30 generated sets, or one eval run (about 300), and re-embedding the dev bank (1,086
  rows) takes two days alongside normal use. Once it's spent, generation fails closed until the reset (the
  bank can't be searched without the spec's embedding). Observed 7 Nov: about 90 rows a minute while the
  quota lasted. Billing lifts both limits.
- Old generation records keep `pass | fail | needs_source` verdicts; readers accept both shapes.
- The eval (`npm run questions:eval`) writes its report to `docs/engineering/eval/`; it's the baseline any
  model or prompt change has to beat.
