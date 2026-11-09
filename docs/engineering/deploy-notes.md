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

## Continuous deploy

A push to `main` runs `.github/workflows/deploy.yml`: typecheck and unit tests, the four images built in
GitHub Actions and pushed to DigitalOcean Container Registry tagged with the commit, then
`scripts/deploy.sh` on the droplet over SSH. That script pulls the images, puts the checkout on the commit,
and always stops, migrates and starts (the 0022 rule above, for every release), then waits for the API and
realtime to answer; the job fails with their logs if they don't. Deploys queue in push order; a failed test
or build deploys nothing. Stopping realtime ends live parties, which the worker refunds, so a push to main
mid-party costs those parties. Re-run a release from Actions (or "Run workflow") to deploy it again.

The droplet's checkout belongs to the pipeline: each deploy resets tracked files to the commit, so change
the compose file or Caddyfile in git, never on the box. `.env` is untracked and stays; the script writes only
`IMAGE_REGISTRY` and `IMAGE_TAG` into it, so a hand-run `docker compose` uses the deployed images.

Setup, once:

- **Registry.** Create a DigitalOcean Container Registry (Basic or above: four repositories). Old tags pile up;
  run garbage collection from the registry's settings now and then.
- **DigitalOcean token** with registry read and write: repository secret `DIGITALOCEAN_ACCESS_TOKEN`. It
  stays in GitHub; the droplet gets only a read-only login that expires in 15 minutes and is deleted after.
- **SSH.** A key pair for deploys only (`ssh-keygen -t ed25519 -f contestly-deploy -N ""`): the public key in
  the deploy user's `~/.ssh/authorized_keys` on the droplet, the private key as secret `DEPLOY_SSH_KEY`.
- **Repository variables:** `DO_REGISTRY` (the registry's name), `DEPLOY_HOST` (the droplet's address),
  `DEPLOY_USER`, `DEPLOY_PATH` (the checkout, e.g. `/opt/contestly/contestly-services`) and
  `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <host>`, checked against the droplet's own key).
- **The droplet** can `git fetch` the repo (a read-only deploy key) and has `COMPOSE_PROFILES` in `.env`
  (`mock` on a test box).

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
