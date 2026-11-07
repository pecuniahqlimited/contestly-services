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
- **Party templates (ADR 0015).** Migrations 0049–0054 roll. 0049 writes template config version 1; 0051
  adds the `prize_hold` account kind (an enum value, outside a transaction); 0052 adds
  `user_signals.last_seen_at` and backfills it from `first_seen_at` before it becomes NOT NULL (hand-edited:
  a plain default would make every old IP look used today and link strangers at the next party), so it
  touches every signal row once; 0050 and 0054 rename columns on `held_prizes`, a table nothing older reads.
