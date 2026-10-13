# Contestly Services Architecture

Oct 11, 2026 · @Solomon Amadi

## Shape of the system

Contestly is two repositories deployed independently: `contestly-app` (Expo mobile app, web admin and brand console) and `contestly-services` (five TypeScript backend processes sharing one Postgres and one Valkey). The app never ships with services and services never ship with UI; the contract between them is `packages/shared` (zod schemas, event names, queue names, kobo money helpers), published so the app repo generates a typed client from it.

Traffic enters through Cloudflare, then Caddy on the DigitalOcean droplet, which routes HTTPS to `api` and WebSockets to `realtime`. Everything stateful lives in DO managed Postgres (system of record, append-only ledger) and Valkey (live room state, presence, pub/sub, BullMQ queues, leaderboard sorted sets). The `worker`, `recsys` and `questions` services never take client traffic directly; they are reached through queues, HTTP from `api`, or Valkey pub/sub.

The rule that organises the split: `api` owns writes to the record, `realtime` owns the live round and chat, `worker` owns everything scheduled or retried, `recsys` reads and ranks but never writes game state, and `questions` produces content that nothing can schedule until a host approves it.

_Architecture diagram lives in the live doc: https://claude.ai/code/artifact/57da65e2-d8dc-46e7-a21f-0e13cd06813c_

Clients only ever reach `api` and `realtime`; `worker`, `recsys` and `questions` are reached through queues or internal HTTP, and all five share the same Postgres and Valkey. Realtime and worker meet in Valkey pub/sub, which is how a party status change travels worker → realtime → clients.

## Service inventory

Five services, one Dockerfile with an `APP` build arg, each its own process so any one can be scaled or rewritten alone.

| Service | Port | Owns | Talks to | Scaling |
| --- | --- | --- | --- | --- |
| `apps/api` (Fastify) | 4000 | Users, profiles, follows, brands + teams + verification, guest sessions for free-party invites, party create/discover/detail (title, brief text or PDF, parameters, formats, play-or-host choice), party join (entry charge), wallet and ledger reads, top-up intents, payout requests, Payout Challenge run start and stage decisions, messages history, device tokens and per-category nudge toggles, admin and brand console endpoints, Paystack webhooks | Postgres (writes), Valkey (cache, rate limits), BullMQ (enqueue), `recsys` (HTTP for Home/Parties ordering), `questions` (HTTP to request a set) | Stateless; N instances behind Caddy |
| `apps/realtime` (Colyseus) | 4001 | Party lobby presence, the live round (server-authoritative timing, answer intake, per-format graders, speed-weighted scoring, per-question leaderboard reveal), player flag tally and the void → replace step in the room, party chat and DMs (text, @mentions, emoji, voice-note pointers), onboarding rounds via matchmaking, pushing party status changes to clients | Valkey (room state, presence, pub/sub from worker), Postgres (persist results at round end), `questions` (replacement question on a void), `packages/game` for all rules | Horizontal via Valkey presence/driver; rooms pinned to one instance |
| `apps/worker` (BullMQ) | – | Party start-at-time or cancel-and-refund, generating sealed sets at start, settlement (rake once, split, ledger entries), Payout Challenge decision timers and weekly seat/budget resets, the nudge system (every nudge is a worker event: trigger, audience rule, quiet hours, caps, batching; push via FCM/APNs when closed, in-app banner when open, send/open/dismiss logged), voice-note transcription + moderation queue, prize fulfilment nudges, nightly Paystack reconciliation, question retirement from play stats | Postgres, Valkey, Paystack API, FCM/APNs, Spaces, LLM/transcription provider | Per-queue concurrency; add instances per queue |
| `apps/recsys` | 4002 | Read-model ranking: Home ordering, Parties tab ranking, "filling up now", pairing people into parties, nudge targeting tuned from send/open/dismiss logs, not-interested signals, archetype-first ordering | Postgres read replica or read-only role, Valkey (signals, caches) | Stateless; v1 is weighted rules, every decision logged with a reason |
| `apps/questions` | 4003 | Question engine: free-text brief or uploaded PDF → spec → retrieve → generate → verify → dedupe → review gate → bank. No category picker. Five extensible formats (pick one, pick all, put in order, match pairs, picture round), each with payload schema, grader and generator template; images from a licensed or generated pool only. Two host modes: sealed (automated gate, generated at start, host can play) and curate (host approves, cannot play). Flag → void → replace threshold logic and replacement supply; generation records for admin audit | LLM provider, Postgres (question bank), Spaces (PDF uploads, images, source snapshots), BullMQ for long jobs | Stateless; generation runs as jobs so a slow LLM never blocks `api` |

The app repo adds two clients to this: the Expo mobile app (players, hosts, brand teams on the move) and a web console (admin: budgets, moderation queue, verification review, question audit; brand: party setup, prize fulfilment, team).

## Shared packages

The packages hold everything two or more services need, so no rule lives in two places.

| Package | Holds | Used by |
| --- | --- | --- |
| `packages/game` | Pure game logic, no I/O: party round state machine, question timer, correctness + speed scoring, tie-breaks, payout ladder (stages, walk-away vs risk, decision timer), difficulty tier selection. Tested to the millisecond. | `realtime` (live play), `worker` (settlement and ladder timers), `api` (validating stage decisions) |
| `packages/db` | Drizzle schema, postgres-js client, append-only ledger helpers (post entry with idempotency key, balance views), seed | `api`, `worker`, `realtime`, `questions` |
| `packages/shared` | zod schemas for every request and event, realtime event names, queue names, kobo/naira money helpers, enum constants (party status, prize fulfilment states, verification states). Published for the app repo. | All services and both clients |
| `packages/auth` | `resolveUser()`: dev header or Firebase ID token → users row; brand profile switching (acting-as context); team role checks | `api`, `realtime` |
| `packages/queue` | BullMQ queue definitions, ioredis connections, job payload types | `api` (enqueue), `worker` (process), `questions` (long jobs) |

## Data stores and external providers

Two stores and six providers, each behind an interface so the provider can change without touching game or money rules.

| Component | Role | Notes |
| --- | --- | --- |
| PostgreSQL (DO managed) | System of record: users, brands, teams, parties, entries, results, question bank, ledger, messages, notifications, moderation cases | Real transactions and row locks for the ledger; party join locks the party row. Leaderboards and feeds are plain queries at launch scale |
| Valkey (DO managed) | Hot state: Colyseus room state and presence, pub/sub worker → realtime, BullMQ queues, rate limits, leaderboard sorted sets, recsys signal caches | Nothing here is the source of truth; losing it drops live rooms, not money |
| DigitalOcean Spaces | Avatars, brand logos, prize photos, voice notes, question source snapshots | Presigned uploads from the client; voice notes capped in length |
| Firebase Auth | Phone OTP for Nigerian numbers, Apple and Google sign-in | Only auth; no Firebase database. `AUTH_MODE=dev` for local work |
| Paystack | Top-ups via hosted checkout + webhook; cash payouts via transfers | Behind a `PayoutRail` interface. Other rails: vouchers or airtime (Android), and a manual-fulfilment rail for non-cash prizes with its own status machine |
| FCM + APNs | Push delivery | Device tokens stored by `api`, sends from `worker` with retry and backoff |
| LLM + transcription provider | Question generation and verification; voice-note transcription for moderation | Called only from `questions` and `worker` jobs, never from a request path |
| Cloudflare | DNS, TLS edge, CDN for the web console, WebSocket proxying to `realtime` | Caddy behind it on the droplet terminates and routes |

## Engineering flows

Each flow names which service acts at each step, so ownership is unambiguous when building in Claude Code.

### Party lifecycle

1. **Create** — host (user, or staff acting as a brand) walks the builder: title, one sentence about the round or an uploaded PDF (to Spaces), formats (all five on by default), question count, visibility, funding mode (pooled or host-funded), max players, start time, prize (cash split or non-cash), and **Will you play?** `api` validates with `packages/shared`, writes the party, and enqueues a `party.start` delayed job.
2. **Questions** — *Sealed* (host is playing): nothing is generated until start; `worker` asks `questions` for the set at start time and the automated gate (verify + safety + dedupe) is the approval, so nobody sees it early. *Curate* (host only): `questions` runs now and parks drafts; the host approves, edits, swaps or regenerates in the app, and is locked out of playing. The lobby and game header always disclose "AI questions · sealed" or "host-reviewed".
3. **Discover and share** — `recsys` ranks the party into Home and Parties for the right people (follows, picks, "filling up"). Share links carry the referral code. Follows with per-follow alerts trigger a nudge in `worker`.
4. **Join** — an invite to a free party allows guest play through a guest session; a staked party requires signup. `api` charges bonus coins first, then cash, in one transaction with a row lock on the party; the ledger entry carries an idempotency key, so a replayed join is a no-op and insufficient funds returns 402. Lobby presence updates through `realtime`.
5. **Lobby** — `realtime` holds the Colyseus room: presence, chat with @mentions and stickers, the "filling up" state published to Valkey so `recsys` and the Home card see it. Home shows the joined party in four states (later, soon, starting, live) and `worker` fires the T-5 and live nudges.
6. **Start or cancel** — at start time `worker` flips the party to live (or cancels and refunds every entry via the ledger if fewer than two joined), generates the sealed set if needed, and publishes the status change on Valkey; `realtime` moves the room into play.
7. **Play** — `realtime` runs the round from `packages/game`: one question at a time, timed, graded by its format (pick one; pick all with partial credit and wrong picks subtracting; order scored per position; pairs scored per pair; picture round), speed-weighted, a leaderboard reveal after every question. Chat is live only during reveals. Correct answers never leave the server before the question closes.
8. **Flag → void → replace** — any player flags a question with one of five reasons; `realtime` tallies per room and past the threshold (share of players, with a floor) voids it for everyone, removes it from scoring, appends a verified replacement from `questions` to the end of the set, and tells the room. The flagged question is retired from the bank pending review; tally, threshold and replacement are logged per party.
9. **Finish** — `realtime` persists results to Postgres and enqueues `party.settle`; the result screen shows how many questions were voided.
10. **Settle** — `worker` computes the split in `packages/game`, posts ledger entries (prize credits, host cut, rake taken once), marks non-cash prizes as fulfilment cases, and enqueues result notifications, feed items, streak and head-to-head updates.
11. **After** — shareable result card, rematch creates a new party pre-filled from this one, guest follow-up nudge after 24h, and `questions` records answer rate, time-to-answer, skips and flags per question for retirement and ranking.

### Payout Challenge run

1. Player starts a run through `api`: entry fee charged via the ledger, seat allocated against the weekly seat and budget, difficulty tier chosen from lifetime banked amount, a run row created.
2. `questions` or the bank supplies a no-repeat set per stage; `api` serves one stage at a time with server-side timing.
3. At each stage end the player decides: walk away (held prize credited by the ledger, run closed) or risk it (next stage). `worker` runs the decision timer; no decision in time is treated as the configured default.
4. A wrong stage ends the run with nothing banked; a full clear credits the final payout. Every credit is checked against per-user daily and weekly win caps and the weekly cashout budget before posting.
5. `worker` resets seats and budgets on the weekly schedule and refreshes leaderboard points.

### Wallet top-up and payout

1. **Top-up** — `api` creates a Paystack transaction reference and returns the checkout URL. Paystack calls the webhook on `api`, which verifies the signature and posts a credit with the reference as idempotency key. A duplicate webhook is a no-op.
2. **Payout request** — `api` validates balance, KYC state and caps, posts a hold entry, enqueues `payout.send`.
3. **Send** — `worker` calls the `PayoutRail` (Paystack transfer, voucher, or manual fulfilment) with retry and backoff; success converts the hold to a debit, failure releases it and notifies the user.
4. **Reconcile** — nightly `worker` job compares Paystack settlement records against the ledger and opens cases for any mismatch.

### Question generation

`questions` turns a host's sentence or PDF into a playable set: brief → spec (count, formats, difficulty tier, language; no category picker) → retrieve from the bank and sources → generate per format template → verify (fail closed on anything unverifiable) → dedupe against the bank and the host's past parties → review gate → bank. In sealed mode the automated gate is the approval and the run happens at party start; in curate mode the host reviews and is barred from playing. Every question keeps its generation record (brief, spec, sources, scores, gate result or approver) for admin audit; edited questions are marked host-authored. The engine also serves replacements during play when a question is voided, and retires questions from play stats and flags.

### Onboarding round

1. New user picks "just me" or "a brand". A brand gets an underlying user, a verification checklist, and a team.
2. Profile data is collected as a timed Party round: `realtime` matchmakes concurrent new users into a shared onboarding room with a live leaderboard, or runs a solo room with a reward-tier path.
3. Picks are written through `api` and become the first signals `recsys` uses to infer archetype and order Home. Home is never blank.

### Nudges and notifications

Every nudge is an event `worker` emits, delivered as push when the app is closed and as an in-app banner when it is open, with identical content and deep link. Each has a trigger, an audience rule, a quiet-hours rule and a cap.

1. A domain event lands in the worker (party T-5, round started, a follow joined, @mention, head-to-head flip, streak at risk, weekly seats released, prize confirmed, guest game ended, no session for 3 or 7 days, verification result, party crossing 60% full close to start).
2. `worker` resolves the audience, applies per-category toggles from `api`, the global cap of 3 pushes a day outside live-party events, quiet hours 23:00–07:00 local (except T-5 and live for parties the user joined), and batching ("Ada and 2 others").
3. It writes the in-app notification row, publishes to Valkey so `realtime` shows the banner if the user is online, and otherwise sends through FCM/APNs with retry.
4. Send, open and dismiss are logged per nudge; `recsys` reads those logs to tune who gets what. No push ever leads with money.

## Cross-cutting rules

These hold in every service and belong in `CLAUDE.md` so the coding agent never relaxes them.

- **Money is integer kobo**, cash and bonus coins are separate accounts, and the ledger is append-only with an idempotency key on every entry. Balances are derived, never stored as a mutable column.
- **Server authority**: timing, scoring, graders, tie-breaks and payouts run in `packages/game` on the server. Clients render; they never decide.
- **Idempotency everywhere money moves**: join, webhook, settle, payout. Replaying any of them is a no-op.
- **Fail closed**: unverifiable questions are rejected, sets that fail the gate cannot be scheduled, payouts that breach caps or budget do not post.
- **Never leak**: correct answers stay server-side until the question closes; sealed sets are visible to nobody, including the host's team, until start; curated drafts are visible only to the host's team, and anyone who has seen a draft is barred from playing that party.
- **Always disclose** that questions are AI-generated and whether the set is sealed or host-reviewed.
- **Never present fake presence**: counts, "filling up" and leaderboards come from real room state.
- **Money is never the headline**: Home, onboarding and every push lead with play and people, not pots.
- **Non-cash prizes are a fulfilment state machine** (pledged → won → claimed → fulfilled, with disputes), not a cash entry with a note.
- **Recsys reads, never writes** game or money state, always returns something, and every suggestion carries a reason the UI can show. Not-interested sticks.
- **Nudges are worker-owned events** with push and in-app parity, opt-in at the first concrete moment (never on launch), per-category toggles, caps and quiet hours.
- **Images in questions** come from a licensed or generated pool with alt text; the engine never hot-links web images.
- **Trust and safety**: block, mute, report; profanity filter at the composer; voice notes transcribed and moderated asynchronously; ban freezes the wallet. Brands can message players who joined their parties, never cold.
- **Observability**: every service emits structured logs with request and party IDs; settlement, payout and generation jobs are traced end to end; recsys logs each decision and reason.

## Deployment on DigitalOcean

One droplet runs the five service containers behind Caddy; Postgres and Valkey are DO managed; the web console is static on a CDN; Cloudflare fronts everything. CI builds one image per service from the single Dockerfile and deploys to a staging compose stack before production. The mobile app ships through Expo with OTA updates for copy and balance changes.

Build order, matching the roadmap already in `CLAUDE.md`:

1. Repo split (`contestly-services`, `contestly-app`) and the published `packages/shared`.
2. Game engine in `packages/game` (round state machine, the five format graders) and Colyseus rooms in `realtime`; decide the host entity.
3. `questions` service: bank and retrieval first, then brief/PDF → generate → verify → dedupe → gate; sealed and curate modes; flag → void → replace in the room.
4. Payout Challenge: stages, decision timer, weekly seats and budget.
5. Accounts: brands, teams, profile switching, verification; guest sessions for free-party invites.
6. `recsys` v1: rules and weighted scores with logged reasons.
7. Chat: party chat and DMs on one composer, voice notes to Spaces, transcription and moderation in `worker`.
8. Feed, friends leaderboard, profile stats from real results.
9. Nudges: device tokens, FCM/APNs and in-app banners in `worker`; the full trigger catalogue with caps, quiet hours, toggles and send/open/dismiss logging.
10. Paystack: top-ups, pluggable payout rail, nightly reconciliation.
11. Trust and safety: block/mute/report, moderation queue, ban and wallet freeze.
12. Firebase Auth end to end, onboarding rounds via matchmaking.
13. Caddy, CI, staging, production.

## Open decisions

- [ ] **Host entity** — one `host` owner that is a user or a brand (Akinola's view), or the brand as public host with the creating staff user recorded underneath. Decide at party-creation time and write a short ADR.
- [ ] **Concurrency targets** — how many concurrent parties and players per `realtime` instance to load-test against before launch.
- [ ] **LLM and transcription providers** — which models sit behind `questions` and the voice-note moderation job, and their cost per party.
- [ ] **Read replica for recsys** — read-only role on the primary at launch, or a replica once Home queries show up in Postgres load.
- [ ] **Payout Challenge content** — trivia only at launch, or the puzzle types (word search, scramble, pattern) as separate game modules in `packages/game`.
