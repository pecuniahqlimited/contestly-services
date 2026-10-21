# Contestly

Social trivia app for the Nigerian market. This is a **ground-up rebuild** that replaces an earlier Contestly app. Treat it as a brand-new product: do not look for, assume, or reproduce anything from the previous codebase, schema, or UI. The only inputs are this repo, the docs under `docs/` and the prototype in `contestly-app` (see Reference docs). Keep the design clean and lean; when in doubt, remove rather than add.

## What we're building (agreed direction, Oct 2026)

Two game modes and a social layer. Everything else serves these.

- **Party**: Kahoot-style live rounds. One question at a time for everyone in the room, server-timed, ranked in real time, with a chat per party while you play. Hosted by a person or a brand; joined by people. Pot is pooled from entries or provided by the host; a host's prize is cash, or for a verified brand a product or an experience. Every prize is shared by one of a fixed set of splits (winner takes all, 70/30, 60/30/10), and entry, seats and the host's cash prize stay inside admin-set party limits. Many parties run concurrently (plan for thousands), each with a configurable max players (plan for hundreds).
- **The Climb**: solo, free, unlimited runs up a ladder of N stages (config in the database, edited in the admin console; currently 5). Each stage is a few short puzzle rounds of one of its allowed game types (pattern, scramble, word hunt, quick maths, memory); clear enough rounds (default 2 of 3, the final stage 3 of 3) to clear the stage. A run ends when you miss a stage or clear the last one; its points are the sum of the stages cleared (default 10/20/30/40/50). No entry, no walk-away, no prize held per stage. Your daily score is your best run that day, your weekly score is the sum of daily scores plus Today's challenge (an admin-written quiz, one go, up to +100). Weeks run Monday–Sunday and days are Africa/Lagos. Boards: Everyone and Friends (weekly); at week close the top X on Everyone (admin config) win cash prizes after an admin approves them. Streak = consecutive days with a run.
- **Social**: follow people and verified brands, per-follow party alerts, tappable profiles with head-to-head records and one-tap Challenge, shareable results, referrals, streaks, rematch. The leaderboard is **friends-first** (people you follow); Everyone sits behind a tab and is the board weekly Climb prizes come from. Interest-based communities may come later.
- **Chats is a top-level tab** (Home · Parties · + · Chats · Me) with Messages, Party rooms and Activity inside it. Activity is not its own tab.
- **Chat**: two kinds, one composer. Party chat (scoped to a party, lives while the party lives) and one-to-one messages between people. Both support text with @mentions, emoji, and hold-to-record voice notes (short, capped, uploaded to object storage, transcribed later for moderation). **No general chat room.** Brands can message players who've joined their parties, not cold.
- **Brands host; they don't join parties as players.**

### Accounts and hosting

- One login. A person may hold a personal profile and run one or more brand profiles, and switch between them in-app. Onboarding asks up front: *just me* or *a brand*. A brand onboarded directly gets an underlying user created for it (verified by phone or business email), plus a verification checklist afterwards (registration number, logo, site/social, business email; payout account only if giving cash).
- A brand has a team: multiple users with roles can host on its behalf; invite by username, or invite someone who isn't on the app yet.
- A party is always created by a specific user (we keep that), and is publicly hosted by either that person or a brand. **How to model the host is an open design question** (see below). Don't lock in a table shape for it without a short written note on the trade-off.

### Home and recommendations

- **Never a blank Home.** If a user follows nobody and nothing is open, Home still gives them a move: start a party, play Today's challenge, start a Climb run, people and brands to follow.
- A **recommendation service** decides what Home and the Parties tab lead with, using onboarding picks (interests, "why are you here", flex), follows, and behaviour. It also surfaces parties that are filling up right now ("PlayStation-style: people are in this one, join"), and pairs people who'd enjoy a party together. Users can mark any suggestion "not interested" and it should learn from that.
- The archetype from onboarding (competitor / host / grinder / fan) only changes what's first; everyone still sees both modes.
- **Lead with play, not money.** Decided: no screen leads with amounts paid out, pots, or "win cash". The first screen is the brand and one plain line about what the app is (live quiz parties with friends; solo challenges), then Jump in. Home leads with the game and the people in it. Prizes appear where they're relevant (a party's pot, a stage's prize) and nowhere as a headline. Copy says "play", "beat", "climb", "bragging rights"; it never says "win real money" or "cash out" as a pitch. This is a product decision and a store-review one: the app must read as a skill game, not a gambling app.

### Onboarding

A 90-second party, not a form, and it ends on Home. Three entry states:

- **Direct** (no invite): Welcome → who's playing → two timed picks about you (lanes, multi-select; why you're here) → a bridge screen that says plainly what the next round earns and what it's for ("bag coins for your first party / pot") → three quick-fire questions, right and fast earns coins → result → keep your coins (phone + code) → your people → name and face → **Home**. No "first move" screen; Home already recommends.
- **Invite to a free party** (no entry fee, no cash prize): the invite card leads. **Join as a guest** with just a name: play and chat, score not saved, not eligible for prizes, a persistent "sign up" nudge in the lobby and on the result. Or sign up first.
- **Invite to a staked party** (entry fee, or money to be won): sign-up is required, the Welcome says why in one line, and the flow ends in that party's lobby instead of Home.

Brands get brand-specific picks and the verification checklist after name and logo; prize type is chosen per party, not at onboarding. If several people are onboarding at the same time they share the quick-fire round and see a leaderboard; alone, they still play and get the solo reward. Never claim someone is online unless they are. No pick is asked twice; anything collected in onboarding is editable from Me.

Screens, flows and copy are defined by the prototype in `contestly-app` (`../contestly-app/docs/design/contestly-prototype.jsx`); this repo serves the API those screens need.

### Open questions (decide before building the relevant piece)

1. **Host entity.** Options on the table: (a) `parties.created_by_user_id` + nullable `brand_id` and a "host type" flag; (b) a `hosts` table that is either a user or a brand, with `parties.host_id`. Both were argued; neither was chosen. Pick when building party creation, document why in a short ADR in `docs/`.
2. **Question generation.** Direction agreed (see "Question engine" below); the detailed quality thresholds and the first model/provider are still to be chosen. Needed before the game engine is useful.
3. **Concurrency targets.** Agreed in spirit (thousands of parties, hundreds per party). Put real numbers in before load testing.
4. **Communities / interest leaderboards.** Later. Design the leaderboard tables so a scope other than "friends" is possible.

### Party gameplay (Kahoot-style, every round)

Each question runs three beats on the clock, server-scheduled; the client never decides timing or scoring.

1. **Question.** Big question, four coloured answer tiles lettered A–D (or the format's own UI). Tapping selects, and the player can change their answer as often as they like until the clock ends; there is **no Lock in button**. Whatever is selected when the clock ends is the answer. Each change goes to the server, which stamps it; the speed bonus uses the time of the **final** selection, so changing late costs points. The clock always runs its full length (no early close, since nobody signals they're done). No chat. Flag available.
2. **Reveal** (short, ~6s, host can cut after a 3s floor). Verdict card: Correct +N (speed bonus included) / Partly +N / Not this one / No answer / Voided. The correct answer is highlighted; your pick carries a "Your pick" marker in a distinct state from "correct but not yours". A per-option distribution (how the room answered, as bars with %) plus "N didn't answer". The explanation sits behind an ⓘ, not inline. No standings here, no chat.
3. **Standings** (~7s, host can advance). A top-5 ladder that **animates from each player's previous rank** (the server sends `prev_rank`; the client never infers it), with ▲/▼ deltas; if you're outside the top 5, your row is pinned below with the gap to 5th. **Chat is open only on this screen**, live-stream style: a pinned composer with the last three messages floating above it; the full thread stays in the party room before, after and from Chats › Parties. Then the next question opens.

Scoring: correctness × (base + speed bonus), partial credit for multi/order/match. Distribution and `correct` are null until the round closes. Reveal duration comes down when standings get their own beat so matches don't get longer. Reduced motion: cross-fade instead of ladder movement. Everything above is UX; the previous app's backend is not a reference.

### Home states for a party you're in

When the user has joined or is hosting an open party, the Party card on Home becomes that party, not a recommendation. Four states by time to start: **later** (friends' faces, "Remind me", "Invite", "Open the lobby"), **soon** (<15 min: details, lobby), **starting** (≤2 min: green, live countdown, "Enter the room"), **live** (round in progress: "Join the round" goes straight to the question). More than one party → "+N more" opens Chats › Parties. Brands see their hosted parties the same way.

### Nudges and notifications (worker-owned)

Every nudge is an event the worker emits, delivered as push when the app is closed and as an in-app banner when it's open, with identical content and deep link. Each has a trigger, an audience rule, a quiet-hours rule, and a cap. First set:

| Nudge | Trigger | Rule |
|---|---|---|
| Party starts in 5 | T-5 min for a party the user joined or hosts | Always; also T-1 if not in the room |
| Party is live | Round started and user not in the room | Once per party |
| Friend joined your party | Someone the user follows joins a party they're in | Max 1 per party per hour, batched ("Ada and 2 others") |
| Party filling up | A party in the user's lane crosses 60% full with <10 min to go | Max 1/day, only if the user has no party in the next hour |
| @mention | Tagged in a party chat or DM | Always, batched per thread |
| Rival beat you | Head-to-head lead flips, or a followed player passes the user on the Climb Friends board | Max 1/day |
| Streak at risk | 3 hours before midnight, today's challenge not played, streak ≥ 2 | Once per day |
| Climb week closed | Week close; the user played The Climb that week | Once per week; leads with rank and people, never the prize |
| Prize ready / delivery nudge | Brand confirms a non-cash prize; then day 3 and 7 if not marked delivered | To winner and brand |
| Guest follow-up | 24h after a guest game | Once |
| Win-back | Day 3 and day 7 with no session; content is what the user's people did | Twice, then stop |
| Verification update | Brand review approved or needs changes | Always |

Rules: opt-in at the first moment there's something concrete to notify about, never on launch; per-category toggles in Me; a global cap of 3 pushes/day outside live-party events; quiet hours 23:00–07:00 local except T-5 and live for parties the user joined; every push carries a deep link and a reason; no push ever leads with money (same rule as Home). Log send, open and dismiss per nudge so the recommendation service can tune who gets what.

### Recommendation engine (its own service)

Decides what each surface leads with: Home hero and mode order, the Parties tab ranking, "filling up now", people and brands to follow, who to pair into a party, and which push to send. Inputs: onboarding picks (lanes, why, flex), follows and mutuals, play history (categories, times of day, win/loss, rivals), party outcomes, explicit "not interested", and liveness (seats filling, friends in a room). Rules:

- **v1 is rules and scores, not ML.** Weighted features in plain code with the weights in config, logged per decision so we can see why something showed. Move to a learned ranker only once there's enough data and the rule version is the baseline to beat.
- **Always returns something.** Cold start falls back to lane → popular → start-your-own. An empty response is a bug.
- **Explainable in-product.** Every recommendation carries a short reason ("Kemi is in", "Afrobeats, your lane", "filling up") that the UI can show.
- **Negative signals stick.** "Not interested" on a party type, category or host lowers it for that user and is never silently reset.
- **Reads, never writes game state.** It's a read-model service over Postgres/Valkey; it can't create, join or charge anything.

### Question engine (its own service)

Hosts give the party a name and **anything as the source**: free text of any length (a topic, a vibe, a list of facts, in-jokes) and/or an uploaded file (PDF, DOCX, slides, images of notes). There is no category picker; the engine infers topic, audience and tone from the input and shows a one-line "what we understood" back. Then parameters: difficulty (easy / mixed / hard / brutal), seconds per question, formats to allow, how many questions. The engine does the rest. **Source files are read, never stored.** The app sends the file straight to the API (multipart, size-capped); the API extracts the text in memory (off the event loop), discards the bytes, and keeps only the extracted text, chunked, as that party's retrieval source. No source file ever goes to object storage or into a queue payload. Questions from a file must be answerable from it, and the record stores which chunk each came from. The chunks live only as long as they're needed: they're deleted a set retention window after the party finishes (config, default 30 days, for disputes and flag review). Replacing a file means sending a new one; its chunks replace the old. A derived category tag is still stored on the party for discovery and recommendations, inferred rather than chosen.

**Creation is a builder, not a form.** Six scenes on the game surface: About (name; type anything or attach a file; a live party poster builds as you type), Dial it in (difficulty faces, a pace dial, question count, format tiles), Your role (playing vs hosting), Stakes (coin-stack quick picks for entry or your own amount, seats as quick picks or a stepper, the host's cash prize or a verified brand's goods per place, the split, all inside the admin's party limits from `GET /parties/limits`), Doors (public/private, cover), and the **Forge**: the generation itself shown to everyone as a deck of cards appearing one by one with the pipeline stage named (reading, drafting, checking, dedupe, balance). In sealed mode the cards appear face-down with a lock and a format icon; in curate mode they flip to reveal the question for approve/swap. The host always sees the deck being made; whether they see its contents depends on the mode.

**Two host modes.** *Sealed* (default): the host is playing, so the host never sees the questions; the set is generated **as soon as the party is created**, fact-checked and sealed, so it's ready long before start and a failed generation surfaces to the host while there's time to fix it, not as a cancel-and-refund at start. Sealed means access, not timing: no API, admin view or log ever returns a sealed set's content before start, and the host gets the same first look as everyone else. At start the engine re-checks the set against the final roster and swaps out (from reserves, then the bank, then a quick top-up) any question someone who joined after generation has already seen. *Curate*: the host reviews and approves every question before the party and therefore cannot play. The lobby and the game screen always disclose that questions are AI-generated, and whether the set is sealed or host-reviewed.

**Formats.** Questions are not only text and not only pick-one. Supported from the start, each with its own answer UI, scoring and generator template: pick one; pick all that apply (partial credit, wrong picks subtract); put in order (scored per correct position); match pairs (scored per correct pair); picture round (an image with a caption, then pick one). Images come from a licensed or generated pool with alt text; the engine never hot-links random web images. Formats are configurable per party and the catalogue is extensible (type the format, its payload schema, its grader, and its template).

**Player flags.** During play anyone can flag a question (wrong answer, more than one right answer, unclear, out of date, inappropriate). The engine tallies flags per room; past a threshold (share of players, with a floor) it voids the question for everyone in that party, removes it from scoring, appends a verified replacement from the bank to the end of the set, and tells the room. The flagged question is retired from the bank pending review. All of this is engine-side, in real time, with no host involvement.

Process for generating a set, in order, and every step leaves a record:

1. **Input → spec.** Turn the host's text and any uploaded material into a structured spec: inferred topic and category tag, audience, tone, difficulty, seconds per question, count, formats, exclusions ("nothing about politics"), language/register, and the source scope (open knowledge vs. "only from this file"). Show the one-line summary back; it's what we generate from.
2. **Retrieve before generating.** With a file: retrieve from the file's chunks and generate only from them, citing the chunk. Without: pull candidates from the bank that match the spec first, never one any seated player has already been shown and never one generated from another party's file; generation only fills the gap. Reusing proven questions is the strongest anti-slop measure we have.
3. **Generate with constraints.** For each new question: one unambiguous correct answer, three plausible distractors of the same type and length, no trick wording, no "all of the above", no questions whose answer is in the question, no dates or figures that change (prices, "current" office holders, ages), locally grounded where the lane is Nigerian.
4. **Verify facts independently.** A second, separate pass checks each answer against at least two sources or a curated reference; anything unverifiable is marked "needs a source" and rejected at the gate in both modes (in curate mode the host swaps or regenerates that slot; rescuing it with a host edit is not built, see ADR 0003). Generation and verification are never the same call.
5. **Dedupe semantically.** Embed and compare against the bank and the current draft; drop near-duplicates and lookalikes (same fact, different wording).
6. **Score difficulty** from retrieval stats where the question has been played, otherwise from a model estimate marked as such; recalibrate from real answer rates after play.
7. **Safety and taste filter.** Profanity, hate, sexual content, real private individuals, gambling or alcohol promotion, politics unless the brief asked for it. Fail closed.
8. **Review.** Sealed mode: an automated review gate (verification + safety + dedupe all pass) is the approval; no human sees the set before start. Curate mode: the host approves, edits, swaps or regenerates per question; edited questions are marked host-authored and stay out of the shared bank; the host's team and anyone who opened the drafts are locked out of playing (ADR 0003).
9. **Learn from play.** Record answer rate, time-to-answer, skips, reports and "bad question" flags per question. Questions below thresholds are retired automatically; good ones rise in retrieval.
10. **Never leak.** Correct answers never leave the server before the round closes. Sealed sets are visible to nobody, including the host's team, until start. Curated drafts are visible only to the host's team, and anyone who has seen a draft is barred from playing that party.
11. **Flag → void → replace** at runtime, as above, with the tally, threshold and replacement logged per party.

Admins can see the generation record for any question: brief, spec, sources, scores, who approved.

## Reference docs

Read these before starting a roadmap step. If they disagree with this file, this file wins; flag the conflict instead of guessing.

- `docs/product/Contestly-User-Intents.md`: what users are trying to do, screen by screen, and the open product questions.
- `docs/engineering/contestly-services-architecture.md`: which service owns each step of each flow (party lifecycle, The Climb, wallet, question generation, onboarding, nudges).
- `../contestly-app/docs/design/contestly-prototype.jsx`: the clickable UI reference (lives only in the app repo).
- `../contestly-app/docs/design/canvases.md`: the later design canvases (Stakes; The Climb and crews) with links and `.dc.html` sources. Where a canvas covers a screen or admin page, it supersedes the prototype.
- `docs/adr/`: decisions that could have gone either way (one page each).

## Layout

**Two repositories, deployed independently.** UI never ships with services and vice versa.

`contestly-services` (this repo):
```
apps/api            Fastify HTTP API          :4000   users, follows, parties, wallet, messages
apps/realtime       game rooms + chat         :4001   Colyseus rooms: party rounds, lobby presence, party chat, DMs
apps/worker         BullMQ                             notifications, party start/cancel + refunds, resets, prize fulfilment nudges
apps/recsys         recommendation service    :4002   read-model ranking for Home, Parties, pairing, pushes
apps/questions      question engine (BullMQ consumer, no port)   brief → spec → retrieve → generate → verify → dedupe → review
packages/shared     zod schemas, event names (RT), queue names, money helpers (kobo/naira); published so the UI repo can depend on it
packages/db         Drizzle schema, postgres-js client, append-only ledger, seed
packages/auth       resolveUser(): dev header or Firebase ID token → users row
packages/queue      BullMQ queues + ioredis connections
packages/game       pure game logic: party round, Climb game types + ladder, scoring, tie-breaks, flag → void. No I/O.
packages/storage    ObjectStore interface + S3 implementation (DO Spaces in prod, SeaweedFS locally): presigned uploads, reads. For media only; never party source files
```

`contestly-app` (sibling repo, `../contestly-app`): the Expo mobile app, the Vite web app (admin, brand console, share pages), design tokens, and `@contestly/api-client`, a typed client hand-written on top of the zod schemas in `@contestly/shared` for now (codegen later). It links `@contestly/shared` from this repo with `file:` until the package is published (see README). Changing a schema in `packages/shared` changes the app's contract: rebuild shared and typecheck the app repo too.

One Dockerfile per service repo build (`APP` build arg picks the process); each service is its own container and can be scaled or rewritten independently (Elixir was mentioned for real-time); until then everything is TypeScript. Services share Postgres and Valkey but never each other's tables directly except through `packages/db`.

## Commands

```bash
cp .env.example .env && npm install     # install also builds the shared packages
npm run infra:up        # docker compose: postgres (pgvector image) + valkey + storage (SeaweedFS, S3 API on :8333)
npm run db:migrate      # apply packages/db/drizzle migrations (a fresh database starts from 0000_baseline)
npm run db:generate -- --name <what_changed>   # after editing packages/db/src/schema.ts: writes the next migration; review the SQL, commit it with the schema change
npm run db:baseline     # once, only on a database db:push built before migrations (Oct 2026): marks 0000 applied, then db:migrate
npm run db:seed         # demo users (tunde, ada.o, kemz, segunola, zee + 2 brands) and 3 parties
npm run dev             # api, realtime, worker, questions
npm run build && npm run typecheck
npm test                # unit tests (packages/game, apps/questions)
scripts/smoke.sh        # end-to-end check against the running stack
npm run sim             # the sims against the running stack: sim:sealed (generated set, 3 players),
                        # sim:curate (PDF read → curate review → play with two flag-voids → settle), sim:stakes,
                        # sim:climb (runs, Today's challenge, boards, week close → approved prizes)
```

Dev identity: send header `x-dev-user: <handle>` (AUTH_MODE=dev). Unknown handles are auto-created.

## Non-negotiable rules

- **Money is integer kobo.** Never floats, never naira in the database. `kobo()` / `naira()` in shared.
- **Ledger is append-only.** Never update or delete `ledger_entries`. Balances are materialised in `ledger_accounts` and only change inside `ledger.post()` within a transaction. Every entry has an idempotency key; a replay is a no-op. All ledger writes go through `packages/db/src/ledger.ts`.
- **Cash and bonus coins are separate accounts.** Entries drain bonus first, then cash (`ledger.charge`). Prizes and refunds of cash go to cash; refunds of bonus go to bonus. Bonus is never withdrawable.
- **Non-cash prizes are a fulfilment state machine, not a ledger entry.** One fulfilment per winning place; winner and host are both notified; each has a status (awarded → arranged → delivered / disputed) with nudges from the worker.
- **Only verified brands offer non-cash prizes; everyone else's prizes are cash.** Decided in one place, `canOfferNonCashPrize()` next to `publicHost()` in `packages/db/src/host.ts`; every check (creation, and any later prize edit) calls it, so row 8's brand verification changes only its body. The server refuses anyone else with `prize_needs_verified_brand`.
- **A split needs at least one more seat than it has winners** (Top 3 needs 4+ seats), so nobody is guaranteed a prize. Enforced on the server by `checkStakes()` in `packages/shared`, with the admin's party limits (entry, seats, host prize range, allowed splits, quick picks) in app_config "party". The app runs the same check only to explain; new parties use the current limits and keep a copy (`parties.limits`), so changing them never touches an existing party.
- **A host's cash prize is held at creation.** `ledger.hold()` takes the full prize from the host's cash (idempotency key `party_fund:<partyId>`; 402 if it isn't there), settlement pays it out by place with no rake, and a cancel `ledger.release()`s exactly what was held. Pooled pots take the rake once.
- **Server is authoritative for games.** The server stamps send/receive times, never sends the correct answer ahead of time, and computes scores and payouts itself. Clients only submit answers. Scoring uses server timestamps only, with a measured round-trip allowance per client.
- **Joins lock the party row** (`for update`) so a full party can't be oversubscribed.
- **Live rooms live in process; everything around them lives in Valkey.** Colyseus keeps each room's state in memory on the one realtime process hosting it. Do not try to move live room state into Valkey. Valkey holds presence, room discovery (Colyseus Redis presence and driver) and pub/sub, so any instance can find any room and adding a second instance is config, not code. Results are persisted to Postgres when a round ends; if a room disappears mid-round (process crash, deploy), the worker cancels and refunds that party through the ledger. Clients reconnect with Colyseus reconnection tokens. Worker → realtime communication goes over the `party:events` Valkey channel, never direct calls.
- **Services never call each other over HTTP.** API enqueues jobs; worker processes them; realtime subscribes.
- **Validate at the edge with zod** from `@contestly/shared`; the same schemas are used by the UI's api-client.
- Media people keep (avatars, covers, logos, voice notes) goes to object storage via presigned URLs, never through the API. Party source files are the opposite: sent to the API, read, and never stored (see Question engine).
- **Never present fake presence.** Bots or sample data in a prototype are fine; in the product, "online", "playing now" and "N people in your round" must be true.

## Conventions

- TypeScript, ESM, Node 22. `tsx watch` in dev, `tsc` build.
- Drizzle for all queries; raw `sql` only for aggregates Drizzle can't express.
- Every schema change ships as a migration: edit `schema.ts`, `npm run db:generate -- --name <what_changed>`, read the SQL (renames and enum changes need care; hand-edit it where Drizzle guesses wrong), commit both together, then `db:migrate`. Never `drizzle-kit push`, and never change a migration that has been committed.
- Route handlers stay thin; anything touching money or game state lives in `packages/db`, `packages/game` or a service module so API, realtime and worker share it.
- Errors: throw `Unauthorized`, `InsufficientFunds`, or an Error with `statusCode`; the API error handler maps them. Validate `:id` params with `uuidParam()`.
- Heartbeats on sockets stay under 30s (Cloudflare drops idle WebSockets at ~100s). Clients reconnect and rejoin their room automatically.
- Decisions that could have gone either way get a one-page ADR in `docs/adr/`.

## Code quality

Apply SOLID and clean-code principles the way they are meant: to keep change cheap, not to add layers.

- **One reason to change.** A module owns one concern: a route handler parses and replies; a service module decides; `packages/db` persists; `packages/game` computes. Anything that does two of these is split.
- **Open for extension, closed for edits.** Things that come in kinds (question formats, payout rails, LLM providers, nudge types, graders) are registries. Adding a kind adds a file and registers it; it never edits a switch statement in three places.
- **Depend on interfaces, inject the implementation.** Anything external (LLM providers, Paystack, FCM, object storage, the clock) sits behind a small vendor-neutral interface and is passed in, so every pipeline is unit-testable with a fake. No vendor SDK type leaks past its adapter.
- **Interfaces are earned.** Abstract only where a second implementation exists or is planned in this file. One implementation with no plan for a second is a plain function. Don't add a layer "in case".
- **DRY means one source of truth,** not zero repetition. Money rules, host resolution, scoring and validation each live in exactly one place and are imported, never re-implemented. Two similar lines are fine; two copies of a rule are a bug.
- **Small and named.** Functions do one thing and fit on a screen. Names say what, not how. No boolean parameters that flip behaviour; use two functions or an options object. No magic numbers; config or a named constant.
- **Errors are typed and handled once,** at the edge. Inner code throws the shared error types; the API error handler and job wrappers map them. No swallowed exceptions, no `catch {}`.
- **Tests go with the logic.** Pure modules get unit tests covering the edge cases (ties, zero players, late answers, rounding). Flows get one end-to-end script. A bug fix adds the test that would have caught it.
- **Refactor when touching, not on a tour.** Leave a file cleaner than you found it, but don't rewrite modules the task doesn't touch. Big restructures get their own commit with no behaviour change.
- **Before committing, review your own diff** against this list and say in the summary which of these you bent and why.

## Stack

Fastify (HTTP), Colyseus on WebSockets for game rooms and chat (rooms, state sync, reconnection tokens, matchmaking for shared onboarding rounds), BullMQ on Valkey (jobs, delayed and repeatable), PostgreSQL via Drizzle, Valkey (hot state, presence, pub/sub, leaderboard sorted sets), Firebase Auth (phone OTP, Apple, Google), Paystack behind a `PayoutRail` interface, DigitalOcean Spaces. UI stack (Expo, Vite) is documented in `contestly-app`.

## Deployment target (not yet; don't deploy without being asked)

DigitalOcean. One droplet runs the containers behind Caddy; DO Managed Postgres (has PgBouncer) and Managed Valkey on the private VPC; Spaces for images; frontend static on a CDN; Cloudflare in front. GitHub Actions → DO Container Registry. Region LON1. Secrets via Doppler/Infisical, not .env on the box. Payments: Paystack webhooks (verify signature, idempotent). Payout rail is pluggable per platform: cash transfers on iOS/web, vouchers/airtime on Android (Play Store policy).

## Roadmap, in build order

Agreed Oct 2026. Step numbers are stable IDs (other docs and ADRs refer to them); the list is in the order we build. The rule: **the backend leads and the app follows one step behind.** An app screen is built only once its endpoints exist; until then it's an honest empty state, never hard-coded demo data. Seeded rows in the dev database are fine.

Done:
- ~~0. Split the repos~~: UI in `contestly-app`, `@contestly/shared` linked via `file:` (publish later), hand-written api-client.
- ~~1. Game engine + Colyseus party room~~: `packages/game` (three-beat round, five graders, speed scoring, prev_rank), PartyRoom, settlement (rake once, split, host cut, non-cash fulfilment), crash watchdog. Custom stakes: party limits in config (admin-editable at `/admin/party-limits`, dev-only until admin auth), checkStakes, split ids, host cash prize held and paid by place, goods for verified brands with one fulfilment per place. Host entity: ADR 0001 (option A).
- ~~2. Question engine v1~~: `apps/questions` with bank + retrieval (pgvector), generation with verify/dedupe/safety/gate, sealed and curate host modes, PDF/DOCX sources, flag → void → replace, retirement, no repeats for seated players. Providers are mocks behind `Generator`/`Verifier`/`Embedder`; choosing the first real provider is open question 2. ADRs 0002, 0003.

- ~~3. The Climb (services)~~: game-type registry (pattern, scramble, word hunt, quick maths, memory) and ladder engine in `packages/game`; versioned ladder in `climb_ladders`; runs and Today's challenge over HTTP with server timing and catch-up (ADR 0005); day/week scores in Postgres, Everyone board in Valkey sorted sets with a start-of-day snapshot, Friends read from it; worker `day_start` and `week_close`; weekly prizes as versioned admin config (`climb_prize_configs`, each week pinned to the version current when it began); admin-approved weekly awards paid through the ledger (`climb_award:<id>`), held for accounts that can't be paid yet (`canBePaidCash()`, row 5 changes its body). `npm run sim:climb`.

Next, in order:
1. **App: play a party** (contestly-app slice B): lobby, live game, result. Plus `npm run dev:bots` here (dev only).
2. **App: create a party** (slice C): the six-scene builder and the Forge.
3. **Me and my people** (small, here first): "parties I'm in", follow/unfollow, other people's profiles. Then the app: Home's "your next party" card, Chats › Parties, follow from a party, tappable profiles.
4. **App: The Climb** (contestly-app): Climb home, a run, the leaderboard, and the admin pages (Climb stages, Today's challenge, Weekly winners) from the canvases, against the endpoints below. Home's Party/Climb switch.
5. **Step 10, Firebase Auth and onboarding**: auth end to end; the onboarding party against the API, including shared onboarding rounds via matchmaking. Moved up so friends can install a test build and sign in; fill rate is the thing to test.
6. **Steps 5b + 6, chat and social**: party chat and DMs on one composer; voice notes to object storage with capped length; transcription + moderation queue in the worker. Feed and friends leaderboard queries; profile stats from real results.
7. **Step 5, recommendation service v1** (`apps/recsys`): rules + weighted scores, logged decisions with reasons; Home ordering, Parties ranking, "filling up now", pairing, not-interested. After real users, so it has behaviour to learn from.
8. **Step 4, brands and teams**: brand profiles, team roles, profile switching, verification checklist and review; brand console on web. Replace the curate sim's direct draft-view insert with the real team API.
9. **Step 7, nudges**: device tokens + FCM/APNs in the worker; the nudge table above with triggers, caps, quiet hours, per-category toggles, and send/open/dismiss logging; in-app banner for the same events.
10. **Step 8, Paystack**: top-ups via webhook, payouts via pluggable rail, nightly reconciliation. Removes the dev top-up.
11. **Step 9, trust and safety**: block/mute/report, profanity filter, moderation queue, ban + wallet freeze.
12. **Step 11, deploy**: Caddy, CI, staging, then production. Includes a public endpoint for presigned storage URLs (containers can't hand out storage:8333). Before launch, make bank retrieval use the pgvector HNSW index (today it's an exact full scan, fine for a small bank). Set `PUBLIC_WEB_URL` to the real domain and serve `/p/<id>` (open the app, or the store), so shared invite links work outside the app.
