# ADR 0013: Payments: pluggable providers, verify-then-credit, debit-first withdrawals

Status: accepted (2026-10-31). Roadmap row 10. Makes the ledger double entry.

## Context

Money comes in (top-ups) and goes out (withdrawals) through a provider: Paystack first, maybe others
later, and a voucher or airtime rail on Android (Play Store policy). The one goal above everything else:
no glitch, retry, race or bad provider answer can create money or lose it. Providers answer late, twice,
wrongly, or not at all; a timeout tells you nothing about whether a transfer went out.

## Decision

1. **Providers are pluggable** (`packages/payments`). `CollectionProvider` (start a top-up, verify one by
   our reference, list a day's) and `PayoutProvider` (bank directory, create a recipient, send a transfer
   with our reference, query by our reference, list a day's), plus webhook authentication and reading.
   Everything outside `src/providers/` speaks our types: a check is `success | failed | pending |
   not_found | unknown`, and a provider maps its own codes inside its file; anything it can't map is
   `unknown`, never success or failure. Amounts are converted and checked (whole kobo) inside the provider.
   **Adding a provider is one file implementing `PaymentProvider`, one line in the registry, and its env.**
   Nothing else names a provider. A voucher/airtime rail adds a destination kind and a `PayoutProvider`
   without a bank directory. `mock` (dev and tests, never production) is controlled per transaction by
   the kobo part of the amount and keeps its "provider side" in Valkey. `paystack` is the first real one.
2. **Switching** is an admin setting (`payment_settings`, versioned like the email switch; collections and
   payouts apart; `payments.config`; logged with who and why). Secrets stay in env. **Every top-up and
   withdrawal records the provider that created it and is finished by that provider** whatever the
   setting, so a switch strands nothing. Bank accounts are tied to the provider that resolved them; after
   a payouts switch they're resolved again (`account_unresolved`). A live secret key (`sk_live_…`, in any
   variable) outside `NODE_ENV=production` refuses to start.
3. **Top-ups: credit only on a verified confirmation.** The server makes the reference and the pending row
   before the provider is asked; the app never supplies one. The wallet is credited only by
   `confirmTopup()`: a fresh, server-to-server verify with the creating provider, matching our row exactly
   (reference, amount, currency, user in the metadata) and, when a webhook triggered it, the webhook too.
   Any disagreement is `mismatch` (critical alert, an admin decides). Never from the client's redirect,
   never from a webhook body alone. The row is locked while crediting and the ledger key is
   `topup:<provider>:<reference>` (unique per provider and reference too), so concurrent and repeated
   webhooks, checks and admin replays credit at most once. A pending top-up is verified by the worker on a
   backoff until a cutoff (a final verify, then `expired`); a later confirmation still credits through the
   same checks. `GET /wallet/topups/:reference` reads our row only.
4. **Withdrawals: debit first, reverse only on a definite failure.** Checks (`canWithdraw`: verified email
   and phone, not frozen; cash only; minimum; daily count and amount; pause) and the debit (cash →
   `payout_pending:<provider>`) happen in the transaction that creates the payout, with the person's row
   locked; no provider call before it commits. Over a threshold, or a daily ceiling, or a per-user hourly
   rate, it waits for an admin (`payments.approve`; rejecting reverses). The worker marks it `submitted`
   *before* sending; anything `submitted` or `unknown` is queried by our reference before any resend, and
   a resend (same reference, the provider's idempotency key) happens only after the provider says it has
   no such transfer and a quiet period has passed. Definite success → `payout_pending` to
   `payout_settled`, the fee to `payout_fees` (the platform's share from `platform_funds`; who bears it is
   config, default the platform). Definite failure → back to the person's cash. Settling and reversing
   share the ledger key `payout_final:<id>`, so at most one of them can ever exist. Everything else
   (timeout, network error, 5xx, unmapped, the provider's "pending") is `unknown`: requeried with backoff,
   never reversed, never timed out into either outcome; past a cutoff it raises a critical alert. A
   webhook is a hint that triggers a query; a webhook and a query racing make one transition under the row
   lock. A late answer that contradicts a final state (success after we reversed) is a critical alert and
   is never auto-fixed. Pausing payouts refuses new requests and leaves queued ones debited and queued.
5. **Manual finalize and maker-checker.** For a stuck payout (`submitted`, `unknown`) or top-up
   (`pending`, `mismatch`, `expired`) an admin with `payments.finalize` sees a fresh provider check, then
   chooses success or failed with a required reason. The server asks the provider again at that moment and
   keeps its answer with the decision; it applies through the same locked transitions (a manual failed
   reverses once, a manual success settles or credits once). At or above a threshold a second admin
   confirms (and gets their own fresh check). Nobody approves, finalizes or confirms their own
   transaction. All logged in `admin_actions` and `payment_finalizations`.
6. **Permissions.** The admin role stays one flag (`users.is_admin`); payments add four permissions per
   admin (`admin_permissions`): `payments.view`, `.approve`, `.finalize`, `.config`. A `.config` holder
   grants them, never to themselves; dev sessions and seeded dev admins hold all four.
7. **Double entry, and the invariants.** `ledger.journal()` is the only way money moves: legs that sum to
   zero, every account locked in id order, idempotent on its key (a replay with different legs is an
   error, never a no-op). `post()` keeps its signature and adds the platform's side from one type→account
   map, so existing callers didn't change: party money against that party's pot, coins against
   `bonus_issued`, Climb prizes against `prize_funding`, dev top-ups against `dev_mint`. Platform accounts
   are owned by the treasury and scoped (pot per party, payment accounts per provider). A person's cash
   and bonus can't go negative (the lock and a check constraint). Entries from before double entry keep
   no journal and are left alone (append-only); a replay of one of their keys is still a replay.
   The hourly job checks: every journal sums to zero and nothing was written outside a journal since
   double entry began (together: what people hold + pots + pending + settled + fees = what came in − what
   went out); every balance is the sum of its entries; per provider, `topup_in` equals credited top-ups,
   `payout_pending` the open withdrawals, `payout_settled` and `payout_fees` the succeeded ones; and each
   withdrawal was debited once, reversed at most once and only if failed or rejected, settled only if
   succeeded. Any breach alerts and pauses payouts until an admin clears it.
8. **Reconciliation and alerts.** Nightly per provider: our day's top-ups and withdrawals against the
   provider's lists; differences (missing ours, missing theirs, amount, status) go to a table and the
   console; nothing is fixed automatically (a confirmed missed top-up is replayed by an admin through the
   normal verify). Velocity alerts on withdrawals per hour (all, and per person). Alerts are rows deduped by
   key; pushing them to admins' phones is row 9.
9. **Webhooks** at `POST /webhooks/:provider`: authenticate first (Paystack: HMAC-SHA512 of the raw body
   in `x-paystack-signature`), store the raw event (one row per event; redeliveries counted), acknowledge,
   process in the worker. Exempt from the per-IP rate limit only. An optional allow-list of the provider's
   addresses (`PAYMENTS_WEBHOOK_IP_ALLOWLIST=true`).

## Consequences

- Every existing money path now writes two legs; readers that sum a party's money count people's accounts
  only (the pot mirrors them).
- Paystack refusals we can't be sure of (an unverified business, a duplicate reference, a bad key) are
  `unknown`, so such a withdrawal stays debited and alerts rather than being reversed by a guess; an admin
  finalizes it. Only an insufficient provider balance and a rejected recipient are definite failures.
- Deleting an account now also waits for an open withdrawal (`withdrawal_in_progress`); `cash_balance`'s
  copy no longer says "contact support".
- `/wallet/dev-topup` stays for local work and sims (minted against `dev_mint`, 404 in production).
