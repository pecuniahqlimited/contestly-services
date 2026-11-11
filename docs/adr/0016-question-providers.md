# ADR 0016: Real question providers — Claude generates; Claude verifies and checks for now; Gemini embeds and transcribes

Status: accepted (7 Nov 2026), amended twice the same day: verification and the safety check moved to Claude
("Same-vendor verification"), then nothing in dev or testing pays at all: three profiles, mock by default,
a free Gemini-only profile, and the Claude setup as the paid profile, off unless a paid cap is set
("Profiles"); amended 9 Nov 2026 to cut the free profile's calls per set ("Free-tier call volume", agreed,
not built), and 11 Nov 2026 to cut every profile's calls per set instead ("Calls per set", built; it replaces
the 9 Nov amendment and roadmap row 0a), and again 11 Nov 2026 to route profiles by the party's stakes from the
console ("Routing by stakes"; `AI_PROFILE` is no longer the switch). Closes open question
2's provider half. Model ids and prices checked against the providers' own docs and model lists on 7 Nov 2026.

## Context

The question engine (ADRs 0002, 0003) runs behind four vendor-neutral seams (`Generator`, `Verifier`,
`Embedder`, and the worker's `Transcriber`), all mocks until now. The decision of 7 Nov: Claude writes
questions; Gemini fact-checks them with Google Search, embeds them, and transcribes voice notes. Generation
and verification are deliberately different vendors as well as different calls, so a model never grades
its own homework.

## Decision

### Profiles (amendment, 7 Nov 2026)

(Since 11 Nov 2026 the profile is chosen per call by the AI routing config, under an environment ceiling, and
each profile's chat models are set there: "Routing by stakes". The profiles themselves are as below.)

Dev and testing cost nothing. One switch, `AI_PROFILE` (env, read by the questions service, the worker, the
API's console and the eval), picks every provider together:

| Profile | Generate | Verify | Safety | Embed | Transcribe | Costs |
|---|---|---|---|---|---|---|
| `mock` (default) | mock | mock | mock | mock | mock | nothing; no calls |
| `free` | `gemini-3.5-flash-lite` | `gemini-3.6-flash`, no grounding | `gemini-3.1-flash-lite` | `gemini-embedding-2` | `gemini-3.5-transcribe` | $0 (Gemini free tier) |
| `paid` | admin model (`claude-sonnet-5-5`) | admin model (`claude-opus-5-5` + web search; or Gemini + Google Search) | admin model (`claude-haiku-5-5`) | `GEMINI_EMBED_MODEL` | `GEMINI_TRANSCRIBE_MODEL` | real money, under the caps |

**Free.** Free-tier models only (each answered on 7 Nov; `gemini-3.8-flash` and `3.7-flash` were refusing
free-tier calls with 503 "high demand"), the verifier stronger than the writer, as in paid. Grounding has no
free quota, so the free verifier checks from the model's own knowledge with no search, and is told to be
stricter for it: its verdicts carry no sources and are recorded `unsourced: true` with the note "checked
without sources" (the console's generation record shows `checkedWithoutSources`). Only this profile's gate
accepts such a "correct" (`Providers.allowUnsourced`); the paid gate still needs a source. Its verdicts are
cached under their own verifier name, so a paid verifier never reuses one. Every call is a **free-tier
call**: recorded at $0, spaced by a per-model limiter (requests a minute) and counted per model against the
day's quota (`FREE_TIER_LIMITS` in shared; the day is Pacific time, as Google's; `provider_calls.requests`,
migration 0048, counts every request sent, an embedding batch as one per text, retries included). A call
that would pass the quota is refused before it's made: generation falls back to the bank, checks fail closed,
and a set that can't be filled fails as usual. Google's own 429 for a spent daily quota also fails at once.
The embedding limits are Google's as its 429 stated them (100 a minute, 1,000 a day); the chat models'
aren't published, so ours are cautious guesses. The free key must come from a project **without billing**:
on a billed project the same calls are charged.

**Paid.** The Claude setup below, ready for production and **off by default**. Every Anthropic call, Google
Search grounding and every paid-profile Gemini call is a *paid* call (a call nobody marks is paid).
`AI_PAID_CAP_USD` is a hard daily ceiling on paid calls under the admin's caps; **unset or 0 means paid
providers are off**: `providerCall` refuses every paid call before any request, budget check or breaker,
wherever it comes from (a profile, a script, a test that builds its own call path), and records the refusal.
The paid profile won't even start at 0. Production sets the cap; dev and CI never do.

**Nothing in tests, sims or the eval spends by accident.** Unit tests mock HTTP and allow paid calls only by
passing `paidCapMicros` explicitly; the opt-in live test uses the free profile and runs Claude only when the
cap is set too. The sims stop at start against a paid stack unless `SIM_ALLOW_PAID=1`. The eval follows the
profile: `npm run questions:eval -- --free --small` (every lane at mixed difficulty plus the PDF, three
questions each) fits the free day, and with `--free` the eval checks the day's remaining quota per model
before it starts and stops if the run might not fit.

**The paid profile's models (defaults; each step's model is admin config, `questions.providers.models`, from a priced list):**

| Step | Provider · model | Why |
|---|---|---|
| generate | Anthropic `claude-sonnet-5-5`, adaptive thinking, effort `medium` | Half Opus 5.5's price ($2/$10 vs $4/$20 per MTok) for writing that every later step re-checks; Opus 5.5 is one config change away if the eval says Sonnet's distractors or local grounding fall short. Haiku 5.5 is too thin for "plausible distractors of the same type and length". |
| verify (open knowledge) | Anthropic `claude-opus-5-5` + Anthropic's web search tool (`web_search_20260209`, called directly, at most 3 searches), effort `low`, structured output | A different model from the generator, and the stronger one: the only independent check shouldn't be weaker than what it checks. Haiku 5.5 searches but answers from memory more readily (in a probe it skipped the search). About $0.07 a question (≈13k input tokens of search results, $10 per 1,000 searches); the cache pays it once per question. |
| verify (file-scoped) | `claude-opus-5-5`, no search | Checked against the cited chunk only; the web is the wrong source for "only from this file". |
| safety | Anthropic `claude-haiku-5-5`, one call per batch | The small model: a classification task over a few short questions, at $0.10/$0.50 per MTok. |
| verify, safety (option) | Google `gemini-3.8-flash` + Google Search grounding; `gemini-3.5-flash-lite` | The two-vendor setup, for when the Gemini project has billing: pick the Gemini models in the admin console. Grounding costs $14 per 1,000 queries. |
| embed | `gemini-embedding-2` at 1536 dimensions | Current text embedder, normalised at truncated sizes, 8k-token input. 1536 is today's column width, so no vector migration, and stays under pgvector's 2,000-dimension HNSW limit (3072 wouldn't index). Env only (`GEMINI_EMBED_MODEL`): changing it means re-embedding. |
| transcribe | `gemini-3.5-transcribe` | The purpose-built speech-to-text model ($0.003/min). Env (`GEMINI_TRANSCRIBE_MODEL`). |

**Selection.** By profile (above); a profile without its key fails at start and never falls back to another.
In the paid profile, verification and safety take their vendor from the admin's model for the step, on
every call, so moving between Claude and Gemini is a console change with no restart; a model whose vendor's
key isn't set fails that check closed.

**One call path for every provider call** (`packages/ai`): budget check → circuit breaker → timeout →
retries with jittered exponential backoff (429, 5xx, timeouts and network errors only; Retry-After honoured)
→ one usage row. Per call we record provider, model, step, party (when there is one), job, tokens in/out
(cached and thinking separately), search queries, latency, estimated cost in micro-USD, and outcome
(`provider_calls`). Prices are a named table in `@contestly/shared` (`PROVIDER_PRICES`), the only place a
price lives; the admin's model pickers can only choose priced models, so every call has a cost. The breaker
is per process and per provider+step: five consecutive failures open it for 60 s, then one trial call.
Keys go in headers, never URLs, and never into logs or errors.

**Generation.** (Since 11 Nov: one call per set, every format in it; see "Calls per set".) One structured-output call per batch of questions of one format, each format with its own
template (pick one, pick all, order, match, picture): the instructions, a JSON schema, and a mapper to the
game payload. The model gives the answer and the distractors separately and we place the answer and shuffle
(seeded by the question text), so position bias can't leak. The prompt carries every rule from CLAUDE.md's
step 3 and the spec (topic, audience, tone, difficulty, exclusions, register, Nigerian grounding where the
lane is Nigerian). File-scoped specs get only the retrieved chunks and must cite one per question; a draft
citing a chunk it wasn't given is invalid. Picture questions are written only about images in the image pool
(a code list with alt text until a licensed pool exists); a draft naming any other image is invalid, so the
engine never hot-links. Because the pool is short, a set holds at most a quarter of its play order as
pictures, rounded down (amended 10 Nov 2026: was rounded up and counted the reserves in the set's size, so a
3-question set could play two), its reserves included, never more than the pool's images, and never one image
twice (`pictureCap()` in shared, `pipeline/pictures.ts`). It holds at assembly, on the start-time reseal, on a
curate swap and on the fill's fallback to bank originals; a void promotes a picture reserve only while the play
order has room (`promotableReserve()`):
retrieved bank pictures over the cap are dropped (generation fills the gap with other formats), the
generator is asked for no more pictures than the room left, and its pictures over the cap or repeating an
image are dropped before verification, so none is paid for. The `Generator` interface stays general: the client underneath is a plain
"structured call" so the templates branch's `distract()` is a template and a method, not a new client.

**Verification.** (Since 11 Nov: one call per batch of questions, matched by id; see "Calls per set".) A separate call per question, never the generator's call and never the generator's model
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

## Same-vendor verification (amendment, 7 Nov 2026)

There's no Gemini billing for now, and grounding has no free quota. So the paid profile's default verifier
and safety check are Claude: `claude-opus-5-5` with Anthropic's web search verifies, `claude-haiku-5-5` checks safety. The
generator stays `claude-sonnet-5-5`.

This is weaker independence than two vendors. A different model, a separate call with no shared context, and
web sources the verdict has to point at all help, but two Claude models share training data and habits, so
they're more likely to share a wrong belief, or to find the same wording convincing, than Claude and Gemini
would be. The source rule carries more of the weight here: only `correct` with at least one source it was
shown passes the gate.

Dev and testing now use the free or mock profile instead (above), so this is the production default until
it's revisited. **Revisit before launch (row 12):** with Gemini billing on, switch
verify and safety to the Gemini models in the console and compare `npm run questions:eval` reports from both
setups; keep same-vendor verification only if the eval shows it catches as much.

## Free-tier call volume (amendment, 9 Nov 2026; replaced on 11 Nov by "Calls per set", below)

Staging on the free profile hits Gemini 429s. Counted from the code (`pipeline/fill.ts`, `pipeline/judge.ts`,
`providers/drafting/generator.ts`): the spec is plain code; a fill embeds the spec (1 request), asks the
generator for the gap plus `QUALITY_BUFFER` (6) drafts in calls of at most `MAX_PER_CALL` (8) per format,
verifies **every valid draft with its own call** (4 at a time), sends the survivors to safety in one call,
embeds every draft, and runs a second round if it's still short (`MAX_DRAFT_ROUNDS`, 2). A set that comes up
short is retried by BullMQ (the questions queue: 3 attempts).

A 10-question, one-format set with the default 2 reserves needs 12 and asks for 18 drafts:

| | Generate | Verify | Safety | Model calls | Embed requests |
|---|---|---|---|---|---|
| Round 1 | 3 (8 + 8 + 2) | 18 | 1 | 22 | 19 |
| Round 2 (if about 6 passed) | 2 | 12 | 1 | 15 | 12 |

So 22–37 model calls a set, about 80% of them verification, all on `gemini-3.6-flash`: the free model with
the smallest allowance we hold ourselves to (8 a minute, 200 a day). **Verification, not embeddings, is the
free profile's binding limit:** one set's checks take over two minutes at 8 a minute, and the day covers about
5–10 generated sets. This replaces the free-profile estimate in the first two Consequences bullets. A 429 whose
retry wait is longer than the default retry policy waits (8 s; a spent daily quota says hours) marks the
verifier unavailable for the rest of the fill, the remaining drafts fail closed, and after its three attempts
the set is marked failed ("We couldn't make your questions just now"); a party whose set failed is cancelled
and refunded at start.

**Decision, free profile only.** The paid profile keeps one verification call per question, for the reasons
under Alternatives.

1. **Verify in batches.** The free verifier checks up to 8 drafts per call (the generator's batch size) and
   returns one verdict per question, in order, matched by index. A missing, extra or malformed verdict makes
   that question `unverifiable` (fail closed); a whole malformed answer fails the batch closed. It is still
   never the generator's call or model. The cache stays per question: look each draft up before the batch,
   send only the misses, store each definite verdict after. About 18 calls a round become 3.
2. **A smaller quality buffer.** `QUALITY_BUFFER` becomes a per-profile value: 2 on free, 6 on paid.
3. **A verify model with more room.** Revisit `FREE_PROFILE_MODELS.verify`: still a different model from the
   generator and at least as strong, but with a larger free daily allowance. Confirm the real limits from AI
   Studio and the 429s, and update `FREE_TIER_LIMITS` to match.

With all three, the same set asks for 14 drafts: 2 generate + 2 verify + 1 safety = 5 model calls and about
15 embed requests a round. Embeddings (1,000 a day) become the binding limit again, at roughly 60 sets a day.

**Trade-off.** Batch verification was declined under Alternatives because one bad question can colour the
others' verdicts and sources stop being per question. On the free profile the verdicts carry no sources
anyway, and its gate is for the dev bank only, so the trade is acceptable there. Check it before merging:
`npm run questions:eval -- --free --small` before and after; the rejection rate and the share of
`incorrect`/`ambiguous` verdicts shouldn't move by more than noise.

## Calls per set (amendment, 11 Nov 2026; built; replaces "Free-tier call volume" and roadmap row 0a)

The 9 Nov amendment batched verification on the free profile only. Every profile now makes the same few calls
per set, because the saving matters on paid too (each per-question call repeats the system prompt and the
instructions, and each format had its own generation call) and one code path is easier to trust than two.

**Decision, every profile (mock, free, paid):**

1. **Generation: one call per set.** All the set's formats in one structured-output call: `questions` holds a
   list per format, each item that format's own schema, the count spread across formats as before
   (`planShares`, the picture cap included). The first round asks for the gap plus `QUALITY_BUFFER` (6, every
   profile); a second round, if any, asks only for the gap left. A failed call leaves the generator
   unavailable for the round, so the set falls back to the bank (before: a failed format's batch was skipped).
2. **Verification: one call per batch** of up to `questions.providers.verifyBatchSize` questions (admin config,
   default 10, at most 20), from a different model than the generator: with web search on paid, from the
   model's knowledge on free. Inside a batch the order is shuffled (seeded by the claims, so a replay is the
   same) and each question carries an id; the reply is one verdict per id: the verdict, the answer found, a
   note, and on paid the sources behind it. A missing, repeated, malformed or unsourced verdict fails only that
   question closed (`unverifiable`); a reply with no verdict list, or that the call path calls malformed or
   refused, fails only its batch closed; an id that isn't in the batch is ignored. Any other unavailability
   (budget, quota, a circuit open) still stops verification for the fill. Sources stay per question: Claude
   names each verdict's URLs and only results it was shown count; Gemini's grounding supports are mapped to
   the part of the reply each verdict occupies. The cache stays per question, in front of the batching, so a
   question already verified is never sent again. Claude gets 3 searches per open question in the batch.
3. **Safety: one call per set** (as before).
4. **Embeddings: one call per set**, and one per re-embed batch (`EMBED_BATCH` 64). Underneath, each text is
   still its own `embedContent` request (gemini-embedding-2's batch endpoint is async-only), so the free
   tier's per-request quota is counted the same.
5. **Budgets and logging.** The per-party and daily caps are unchanged. Each questions job logs its calls,
   tokens and cost in one line (`[questions] generate_set <party>: AI 4 calls (generate 1, verify 1, safety 1,
   embed 1), … tokens, $…`; a tally in the call context), next to the per-call `provider_calls` rows. The eval
   reports calls per set and what the run would cost on the paid profile, from its tokens.

**Calls per set.** A 10-question party with 2 reserves wants 12 and drafts 18: 1 generate + 2 verify + 1
safety + 1 embed = 5 calls a round (before: 3–5 generate, 18 verify, 1 safety, 2 embed: about 25). The eval's
small set (3 wanted, 9 drafts) is 4 a round.

**Evidence (11 Nov 2026, `npm run questions:eval -- --free --small`, the same five set definitions both sides;
Gemini takes no seed here, so drafts differ run to run).** Before: 62 calls for 5 sets (12.4 a set: 24
generate, 28 verify, 5 safety, 5 embed); 11 of 44 drafts accepted; the verifier answered 18 and rejected 7
(39%); 26 were never checked, because gemini-3.6-flash hit Google's free daily quota after about 20 requests
(its `rpd` in `FREE_TIER_LIMITS` was a guess of 200; now 20). After: 5 generate calls for the same 44 drafts
(19.9k → 6.3k input and 34.5k → 16.1k output tokens; priced as the paid profile's Sonnet 5.5, $0.38 → $0.17),
and every verify call refused by the spent quota, so **the rejection-rate comparison is still to run** once the
quota resets (midnight Pacific). Reports: `docs/engineering/eval/questions-eval-2026-11-11-free-small-before-
batching.*` and `…-free-small.*`.

**Trade-off.** Under Alternatives, batch verification was declined because one bad question can colour the
others' verdicts and sources stop being per question. Shuffling and ids keep position from meaning anything,
sources are required and kept per verdict on paid, every defect fails only its own question, and the eval is
the check that rejections don't rise; if they do on paid, `verifyBatchSize: 1` restores one call per question
from the console, with no deploy.

## Routing by stakes (amendment, 11 Nov 2026; built)

One environment switch made every party in a deployment run one profile: a bragging-rights party paid what a
₦500,000 party did, and changing it took a restart. Now the profile is **routed per call by the party's stakes**,
from the console.

**The config** (`ai_routing_configs`, migration 0064: one immutable row per save, the newest current; `GET/PUT
/admin/ai/routing`, logged with a reason; shared schemas in `packages/shared/src/aiRouting.ts`):

- a **default profile**, for anything not tied to a party: voice-note transcription, an admin's edit of a bank
  question, re-embedding, distractor suggestions before the builder has stakes;
- **prize tiers**, an ordered list of `{ upToKobo, profile }`: the first is bragging rights (`upToKobo: 0`),
  each bound above the last, the last unbounded (`null`). A party's prize is its **maximum possible prize**:
  every seat's entry plus the host's cash prize (`entryKobo × maxPlayers + hostPoolKobo`; goods don't count). A
  bound is inclusive;
- the **models per step** for each profile (moved here from `questions.providers.models`, which version 1 copies
  for the paid profile): free may name only models in `FREE_TIER_LIMITS`, paid generates on Claude, and neither
  verifies with its generator. Embedding and transcription models stay fixed per profile (changing the embedder
  means re-embedding);
- **per-profile caps** beside the global ones in `questions.providers` (which still apply): the paid profile's
  in US cents per party and per day, the free profile's in calls (it costs nothing), counted from
  `provider_calls.profile` (new in 0064). Reaching one refuses the call (the set falls back to the bank, checks
  fail closed) and raises a `ai.profile_cap` warning.

**The ceiling stays in the environment.** `AI_ALLOWED_PROFILES` (dev `mock,free`; production `free,paid`;
unset: `mock,free`, so never paid by accident) and `AI_PAID_CAP_USD` as before. A save that names a profile
outside the ceiling is refused (400 `ai_profile_not_allowed`, with the profiles). At call time a profile the
ceiling doesn't allow (the environment narrowed after a save) falls back to the **highest allowed profile below
it**, logged and raised as an `ai.profile_fallback` warning (one a day per pair); with none below, nothing is
called, and the set fails closed. With `AI_PAID_CAP_USD` at 0 every paid call is still refused before it's sent,
whatever the routing says: the paid profile builds at 0 now (so it can be routed live), and refuses instead.

**`AI_PROFILE` is no longer the switch.** It's only the default written into version 1, the first time anything
reads the routing. Mock, free and paid are all selectable live within the ceiling, dev included.

**Where the tier applies.** Every questions job tied to a party resolves the party's tier and profile when it
starts (`apps/questions/src/routing.ts`), so a set is made and judged under one profile, and the next job sees
any change with no restart: set generation (at creation, for curate and sealed alike), the start-time reseal and
its top-ups, curate replacements (`regenerate_one`), host-edit checks and file embedding. Replacements after a
flag-void come from the set's reserves, made with the set under its tier, so a void makes no call of its own.
Verification runs under the same route as the set it checks. Distractor suggestions use the draft's current
stakes (`stakes` on the request; none: the default profile). The route (`{ profile, configured, tier, prizeKobo,
version }`) is in the call context, so it's on each generation record (`question_generations.route`) and each
provider call (`provider_calls.profile`). Models are still read per call.

**The console** previews a route: `POST /admin/ai/routing/preview { stakes, config? }` gives the prize, the tier,
the configured and effective profile, the models it would use and whether paid is off, changing nothing.

**Trade-offs.** Routing once per job rather than per call means a change lands at the next set, not halfway
through one, so a set is never verified by one profile's gate and accepted by another's. Bank questions are
compared only with rows of the same embedding model, so a mock-routed party never sees free- or paid-embedded
questions (free and paid share `gemini-embedding-2`, so they share the bank); re-embedding follows the default
profile's embedder.

## Alternatives considered

- **Claude for everything.** One vendor, one bill, but the verifier would share the generator's blind spots.
  Adopted for the paid profile for now, with a different and stronger model for verification (above).
- **Paying a little for dev (Claude verification at ~$0.10 a question).** Declined: dev and testing cost
  nothing. The free profile's unsourced checks are weaker than sourced ones, which is why only its own gate
  accepts them.
- **Haiku 5.5 or Sonnet 5 to verify.** Much cheaper, but a weaker or sibling model checking Sonnet 5.5's work
  is the wrong direction for the one independent check. Either is a console switch if cost matters more.
- **Opus 5.5 to generate.** Better on paper; twice the price on the step that's re-checked anyway. Kept as a
  config switch.
- **One verification call per batch.** Declined on 7 Nov (one bad question can colour the others' verdicts,
  and sources stop being per question); adopted on 11 Nov with shuffled ids, per-verdict sources and
  per-question fail-closed ("Calls per set"), the batch size an admin setting.
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
- The free profile's questions enter the dev bank checked without sources. The free tier is a dev tool and a
  dev database only; production runs the paid profile and its gate never accepts an unsourced verdict.
- Google may use free-tier prompts to improve its products: the free profile sees only dev content (sim and
  test briefs, files and voice notes), never real users'.
- Old generation records keep `pass | fail | needs_source` verdicts; readers accept both shapes.
- The eval (`npm run questions:eval`) writes its report to `docs/engineering/eval/`; it's the baseline any
  model or prompt change has to beat.
