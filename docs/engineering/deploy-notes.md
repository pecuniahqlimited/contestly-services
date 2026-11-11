# Deploy notes

Migrations that can't go out with a rolling deploy, and what to do instead. Read before deploying a
release that includes one. Everything not listed here is safe to roll (migrate, then replace instances one
at a time).

## 0022 (payments: double entry) — stop, migrate, start

0022 makes every ledger movement a double-entry journal and adds the payment tables (ADR 0013). From the
moment it runs, every API and worker instance must be on the new code: an old instance still running
writes single-leg entries (no journal), which the hourly invariant job correctly flags as
`entry_outside_journal`, raising a critical alert and pausing payouts until admins clear it.

1. Stop every API and worker instance (realtime and questions too if they share the release; they don't
   write the ledger, but keep the release whole).
2. Run `npm run db:migrate` (0022, and 0023–0036 with it).
3. Start every instance on the new code.

No rolling deploy and no old instance left draining. Before go-live this is the only deploy that needs it.
0023–0036 (the payments reviews' columns and tables) are additive and would roll on their own, but they ship
with 0022, so they go out the same way. (Numbered after main's 0021_admin_alerts, which rolls normally.)

New env with this release (ADR 0013): `PAYSTACK_SECRET_KEY` (a `sk_test_…` key anywhere but production),
`PAYMENTS_RETURN_URL`, optionally `PAYMENTS_WEBHOOK_IP_ALLOWLIST`. Staging and production leave
`PAYMENTS_DEV_TOOLS` unset (and set `NODE_ENV=production` in production).

## Operations: payments break-glass

Not a migration, but it needs the same access. The payments console needs at least two unbanned
`payments.config` holders (ADR 0013). If it ever has fewer and nobody can confirm a grant, someone with
shell access to the droplet runs it inside the running API container, which already has the production
environment and reaches the database (the script ships in every image built from the `Dockerfile`):

```bash
docker compose -f docker-compose.prod.yml exec api \
  npm run payments:break-glass -- --grant-config <handle> --reason "both config holders left; Ada; ticket OPS-123"
```

From a checkout with the production env instead, the same `npm run payments:break-glass -- …` works.
Inside a container the OS user it records is the image's (`node`), so put who is running it in the
reason. It prints what it did, or `break-glass refused: <code>` and exits 1.

It grants `payments.config` to that admin (who must already be an admin, not banned or deleted), logs
`payments.break_glass` in `admin_actions` as the system with the reason and the OS user, and raises a
critical alert to the alert channels. Run it once per admin needed, then use the console's normal
maker-checker flow for anything else. There is no API route for this, by design.

It refuses (`not_stuck`) while there are two or more unbanned holders, since the console can grant it
then. `--force` grants anyway; the `admin_actions` row and the alert both record `force: true`.

## Before launch

- **Dry-run break-glass on staging.** On the staging droplet, with staging at fewer than two
  `payments.config` holders (or with `--force`), run the command above in the API container for a test
  admin. Check the grant shows in the console, the `payments.break_glass` row in the admin log names the
  reason, and the critical alert reached `ADMIN_ALERT_PAYMENTS_EMAILS` (and the general channels as a
  subject and console link). Then revoke the grant through the console. This proves the image, the
  container's database access and the alert path before anyone needs it for real.
- **Real question providers (ADR 0016).** Migrations 0046–0048 are additive and roll. Production runs
  `AI_PROFILE=paid` and **must set `AI_PAID_CAP_USD`** (the hard daily ceiling on paid calls, above the
  console's daily cap or equal to it): at 0 or unset the paid profile won't start, and every paid call is
  refused. Moving from the mock profile changes the embedding space: until the background `reembed` job
  has moved the bank (`embedding_model`), retrieval finds no bank questions and every set is generated, so
  switch before there's traffic, or watch the job's log. The Gemini key must be on a billing-enabled
  project (Google Search grounding has no unpaid quota and is capped at 1,500 grounded requests a day). Set
  the caps in `/admin/questions/providers` before the first real party.
- **Party templates (ADR 0015).** Migrations 0050–0056 roll. 0050 writes template config version 1; 0052
  adds the `prize_hold` account kind (an enum value, outside a transaction); 0053 adds
  `user_signals.last_seen_at` and backfills it from `first_seen_at` before it becomes NOT NULL (hand-edited:
  a plain default would make every old IP look used today and link strangers at the next party), so it
  touches every signal row once; 0051 and 0055 rename columns on `held_prizes`, a table nothing older reads.
  0056 restates every stored rule set (template configs and parties' copies) in the caps-by-host shape with
  every rule explicit, and gives parties without a copy the current one: run it before the new code reads them.

- **Challenge answers split (0063, 11 Nov 2026).** A data-only migration: invitees' `expired` answers become
  `no_show` (a `party_leaves` row at the same moment: they accepted and weren't in the lobby) or `no_answer`.
  Code from before it still writes `expired`, so in a rolling deploy run 0063's two UPDATEs once more after the
  last old process has stopped (they're idempotent).

- **The nudge clock's own queue (11 Nov 2026).** `deliver_nudges`, `nudge_minute` and `nudge_hourly` move from
  the `notify` queue to `nudge_clock`. The new worker removes the three schedulers from `notify` at start and
  upserts them on `nudge_clock`. In a rolling deploy an old worker still running would put them back on `notify`
  when it restarts, which only means ticks on both queues for a while (safe: a tick claims its rows with SKIP
  LOCKED, the emitters record under dedupe keys); once no old worker is left, restart one new worker so it removes
  them again. Set `ALERT_JOB_MISSED_INTERVALS` (default 3) if 3 is wrong for production.

## Repeatable jobs: what stops them, and the liveness alert

**What happened (10 Nov 2026, dev):** nudges went undelivered for about 7 minutes during sim:nudges, twice. Not a
stray process with old code (the idle Wednesday sim, PID 60747, only ever added jobs, and no other worker was
consuming), and not a slow tick: the Mac went into maintenance sleep (20:31:46 for 999 s, 20:56:33 for 419 s;
`pmset -g log`), and everything slept with it, the Docker VM included (Postgres's checkpoint took 497 s instead of
about 270, Valkey's 5-minute save came 4.5 minutes late, and Docker's own clock poll shows 30 s of monotonic time
over 7.5 minutes of wall time). On wake, the sim's party had passed its starts-in-5 window. A machine that stays
awake (the third run, and every server) never shows this.

**What was weak anyway, and is fixed:** the tick shared the `notify` queue and its single slot with every event
job, so a burst of joins or mentions queued ahead of it, and one run that never returned (a push call hanging)
would have held that slot and stopped delivery for good, with nothing to say so. Now the clock has its own queue
with 3 slots (BullMQ queues a scheduler's next run as soon as the current one is picked up, so a slow run doesn't
delay the next), and each run has a deadline (30 s for a delivery tick, 2 min for the minute's emitters, 10 min for
the hourly ones); past it the job fails and its slot is free.

**The liveness alert:** every repeatable job registered with `schedule()` (the nudge clock, the party and payments
sweeps, the invariants and reconciliation, the Climb's day start and week close, alert delivery, lifting
suspensions, the purges) and each live party's watchdog chain is watched. A worker records each completion in
Valkey (`liveness:<queue>:<scheduler>`, `liveness:watchdog:<partyId>`); a 30-second timer in the worker raises a
critical `jobs.stalled` alert for any that hasn't completed in `ALERT_JOB_MISSED_INTERVALS` times its interval,
never under a minute (one per job, deduped for an hour). A job on a cron pattern that runs once a day or less often
(the Climb's day start and week close, the nightly reconciliation, the three purges) would wait days or weeks that
way, so it's watched by when it was due instead: late once it hasn't completed `ALERT_JOB_GRACE_MINUTES` (default
60) after its last due time, and the alert says when that was. It's counted only from the first time the job was
ever scheduled (`liveness:since:<queue>:<scheduler>`, kept across restarts), so a fresh install or a newly added job
doesn't owe a run from before it existed. Hourly jobs (the invariants, the hourly nudges) keep N intervals. A gap between checks of more than 90 s means the process
was suspended: it counts again from the wake rather than paging on everything. It can't see a worker that is
entirely down (the timer goes with it); that's the deploy's health check.

## Load testing: late round timers and the watchdog

**Requirement (10 Nov 2026):** a round timer that fires late must never make the watchdog refund a game that is
still progressing. Late is expected under load (a busy event loop, GC pauses, a throttled or briefly suspended
machine); a refund is for a room that's gone or stuck, not a slow one.

**Seen in dev (10 Nov, sim:social and sim:corners), before the change below:** with the machine stalling, round
timers in the realtime process fired minutes late and the parties were cancelled with "The round was
interrupted. Everyone has been refunded." That was the heartbeat watchdog: the room's heartbeat key expired
while the process wasn't running, and the next watchdog link refunded at once.

**Changed (10 Nov 2026, `apps/worker/src/watchdog.ts`):** a missing heartbeat alone no longer refunds. Two looks
in a row without one, then the stall sweep's recovery (the start republished once, `rekick`, which marks
`stall_rekicked_at`; logged). Only if the next look still finds no heartbeat and no question has opened since the
re-kick is the party cancelled and refunded. A heartbeat at any look, or a question opened since the re-kick,
starts the count again, so a party whose rounds are still progressing is never refunded. The run of missed looks
is kept in Valkey (`party:watchdog:state:<id>`, 10 minutes); losing it only restarts the count. Nothing to do at
deploy: a rolling deploy is fine, and a party mid-chain just starts counting under the new code.

**Today's thresholds:**

| What | Where | Value |
|---|---|---|
| Room heartbeat (`party:room:<id>`) | `PartyRoom.startHeartbeat` | written every 10 s with a 30 s TTL |
| Heartbeat watchdog | `watchdogLink` in `apps/worker/src/watchdog.ts`, chained from `apps/worker/src/index.ts` | first look 45 s after the start, then every 30 s; 2 looks in a row without a heartbeat → one re-kick; still none at the next look and no question opened since the re-kick → cancelled and refunded. So the earliest refund is about 60 s after the first missed look (up to 30 s more for the key to expire). A missing key after the last question settles from the recorded scores |
| Stall sweep | `sweepStalled` in `apps/worker/src/partyStart.ts`, every 60 s | no question opened (`round_progress_at`) for one cycle plus the grace, `stallThresholdSeconds()`: question seconds + reveal 6 + standings 7 + `stallGraceSeconds` 30 (a 20 s question: 63 s); then one re-kick, then cancelled and refunded a threshold later |
| Generation | the same watchdog | a live party with no ready set after `generationTimeoutSeconds` (questions config), refunded at once |

**What the load test should still show:** that under the target load no progressing party is refunded by either
path, and how late round timers actually get. If a process can pause for over a minute and then carry on, the
watchdog's looks (2 before the re-kick, every 30 s) are the numbers to raise; they're constants in
`watchdog.ts` and `index.ts`, not config.
