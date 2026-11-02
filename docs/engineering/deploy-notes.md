# Deploy notes

Migrations that can't go out with a rolling deploy, and what to do instead. Read before deploying a
release that includes one. Everything not listed here is safe to roll (migrate, then replace instances one
at a time).

## 0021 (payments: double entry) — stop, migrate, start

0021 makes every ledger movement a double-entry journal and adds the payment tables (ADR 0013). From the
moment it runs, every API and worker instance must be on the new code: an old instance still running
writes single-leg entries (no journal), which the hourly invariant job correctly flags as
`entry_outside_journal`, raising a critical alert and pausing payouts until admins clear it.

1. Stop every API and worker instance (realtime and questions too if they share the release; they don't
   write the ledger, but keep the release whole).
2. Run `npm run db:migrate` (0021, and 0022 with it).
3. Start every instance on the new code.

No rolling deploy and no old instance left draining. Before go-live this is the only deploy that needs it.
0022 (the payments review's columns and tables) is additive and would roll on its own, but it ships with
0021, so it goes out the same way.

New env with this release (ADR 0013): `PAYSTACK_SECRET_KEY` (a `sk_test_…` key anywhere but production),
`PAYMENTS_RETURN_URL`, optionally `PAYMENTS_WEBHOOK_IP_ALLOWLIST`. Staging and production leave
`PAYMENTS_DEV_TOOLS` unset (and set `NODE_ENV=production` in production).
