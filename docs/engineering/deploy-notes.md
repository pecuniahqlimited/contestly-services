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
shell access to a box that can reach the production database runs, from the repo with production env:

```bash
npm run payments:break-glass -- --grant-config <handle> --reason "both config holders left; ticket OPS-123"
```

It grants `payments.config` to that admin (who must already be an admin, not banned or deleted), logs
`payments.break_glass` in `admin_actions` as the system with the reason and the OS user, and raises a
critical alert to the alert channels. Run it once per admin needed, then use the console's normal
maker-checker flow for anything else. There is no API route for this, by design.
