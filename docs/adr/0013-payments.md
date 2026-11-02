# ADR 0013: Payments: pluggable providers, verify-then-credit, debit-first withdrawals

Status: accepted (2026-10-31; revised 2026-11-02 after an independent review). Roadmap row 10. Makes the
ledger double entry. Migrations 0021 (double entry, the payment tables), 0022 (the review's fixes) and 0023
(waiving what's owed).

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
   without a bank directory. `mock` is controlled per transaction by the kobo part of the amount and keeps
   its "provider side" in Valkey. `paystack` is the first real one. **The mock, its checkout page and
   `/wallet/dev-topup` exist only with `PAYMENTS_DEV_TOOLS=true`, and never when `NODE_ENV=production`
   whatever the flag says**, so a staging box that forgets `NODE_ENV` has none of them. Every provider's
   webhook secret is required, with no default (Paystack signs with its secret key; the mock needs
   `MOCK_PAYMENTS_WEBHOOK_SECRET` or the process refuses to start).
2. **Switching** is an admin setting (`payment_settings`, versioned like the email switch; collections and
   payouts apart; `payments.config`; logged with who and why). Secrets stay in env. **Every top-up and
   withdrawal records the provider that created it and is finished by that provider** whatever the
   setting, so a switch strands nothing. Bank accounts are tied to the provider that resolved them; after
   a payouts switch they're resolved again (`account_unresolved`). Outside `NODE_ENV=production` a live
   secret key (`sk_live_…`, in any variable), or a `PAYSTACK_SECRET_KEY` that isn't `sk_test_…`, refuses
   to start.
3. **Top-ups: credit only on a verified confirmation.** The server makes the reference and the pending row
   before the provider is asked; the app never supplies one. The wallet is credited only by
   `confirmTopup()`: a fresh, server-to-server verify with the creating provider, matching our row exactly
   (reference, amount, currency, user in the metadata) and, when a webhook triggered it, the webhook too.
   Any disagreement is `mismatch` (critical alert, an admin decides). **That verify is the provider's
   confirmation, whoever asks for it:** the webhook's processing, the worker's scheduled check (so a
   missed webhook still credits, with exactly the same matching), or an admin's replay. **The client never
   triggers a credit:** its redirect is ignored and its polling (`GET /wallet/topups/:reference`) reads our
   row only. Never from a webhook body alone. A webhook whose verify still says pending (a provider's
   verify can lag its own webhook) is not marked processed: it's tried again on a backoff by the minute
   sweep until its top-up is credited, failed or expired. The row is locked while crediting and the ledger key is
   `topup:<provider>:<reference>` (unique per provider and reference too), so concurrent and repeated
   webhooks, checks and admin replays credit at most once. A pending top-up is verified by the worker on a
   backoff until a cutoff (24 hours by default, about a Paystack checkout's life); the check at the cutoff
   is the final one (then `expired`, or `failed`); a later confirmation of an expired one still credits
   through the same checks. **A failed attempt isn't final:** a declined card leaves the checkout payable
   (another card, another channel, same reference), so a verify that says `failed` keeps the top-up
   pending, marked `attemptFailed` for the app, until the cutoff. `GET /wallet/topups/:reference` reads our row only. The provider is sent the account's verified email and nothing else: no
   verified email is 409 `email_required` (never a placeholder). If the provider refuses to start
   (`ProviderRefusal`: any 4xx at initialize, or the adapter's own refusal of a reserved test domain such as
   `.invalid` for a real provider) or doesn't answer, nobody got a checkout, so the row is failed at once with
   the reason (422 `topup_refused` with the provider's message, or 502); a row is only scheduled for checks once
   a checkout exists, and the sweep fails any start that never finished.
4. **Withdrawals: debit first, reverse only on a definite failure.** Checks (`canWithdraw`: verified email
   and phone, not frozen; cash only; minimum; daily count and amount; pause) and the debit (cash →
   `payout_pending:<provider>`) happen in the transaction that creates the payout, with the person's row
   locked; no provider call before it commits. Over a threshold, or a daily ceiling, or a per-user hourly
   rate, it waits for an admin (`payments.approve`; rejecting reverses). The worker marks it `submitted`
   *before* sending; anything `submitted` or `unknown` is queried by our reference before any resend, and
   a resend (same reference, the provider's idempotency key) happens only after the provider says it has
   no such transfer and a long quiet period has passed (`resendAfterNotFoundSeconds`, default 30 minutes:
   a provider's lookup can lag its send), and only to the account the first send used if the person still
   has it (if they removed it: no resend, it stays unknown, critical alert). **Only a first send can be
   definitely refused:** on any send after the first, every refusal (insufficient balance, invalid
   recipient, anything) is `unknown` and queried, because the first send may have gone out and be the
   reason for the refusal (it emptied the balance). Definite success → `payout_pending` to
   `payout_settled`, the fee to `payout_fees` (the platform's share from `platform_funds`; who bears it is
   config, default the platform). Definite failure → back to the person's cash. Settling and reversing
   share the ledger key `payout_final:<id>`, so at most one of them can ever exist. Everything else
   (timeout, network error, 5xx, unmapped, the provider's "pending") is `unknown`: requeried with backoff,
   never reversed, never timed out into either outcome; past a cutoff it raises a critical alert. A
   webhook is a hint that triggers a query; a webhook and a query racing make one transition under the row
   lock. Pausing payouts refuses new requests and leaves queued ones debited and queued.
   **A success after we reversed** (the person has the money twice) is handled at once, in the same
   transaction as its critical alert, with the person's row locked: their withdrawals freeze
   (`users.withdrawals_frozen_at`, `payout_contradictions`; `withdraw_not_allowed` with reason
   `payment_review`); every withdrawal of theirs not yet sent (requested, awaiting approval, queued while
   paused) is reversed to their cash (`rejected`, marked `contradiction`); then the disputed amount is
   secured in their `contradiction_hold`: what their cash covers is moved out of cash (so it can't be spent
   on entries either), and the rest is booked as owed at once. A withdrawal already sent (submitted,
   unknown) is left to finish and counted in the alert; if it comes back, the money repays what's owed. A
   send locks the person's row before the payout's and checks the freeze there, so a freeze committing at
   the same moment is never followed by a send. Reconciliation asks the provider about any reversed
   withdrawal it lists as paid, so this happens the same night at the latest. Resolving it is
   maker-checker (`payments.finalize`, then a different admin), and the confirm asks the provider again:
   still paid, the hold becomes the recovery (hold → `payout_settled`, the fee booked as for a settle),
   never back to cash; reversed or failed since, the contradiction dissolves and the person gets back only
   what was taken from them: what was held from their cash plus what they've repaid toward that
   contradiction's debt; a waived part goes back to `platform_funds`; what's still owed for it is cleared
   (their owed account and hold are locked before anything is read; logged with why); anything else, nothing changes
   (409 `provider_not_definite`). Either way the freeze lifts once nothing else is open for them;
   withdrawals stay blocked by `amount_owed` while anything is owed. A failure after a success is a critical
   alert, never auto-fixed.
   **What's owed** (decided 2026-11-02): every new cash credit to that person (winnings, refunds, top-ups,
   anything `ledger.journal()` puts in their cash) repays it first, up to the credit, oldest contradiction's
   debt first, one journal per debt (`owed_repaid`, key `owed_repay:<user>:<the credit's key>:<contradiction>`,
   the owed account locked so two credits can't repay the same debt). Every movement on a person's owed
   account names its contradiction (booked at the freeze, repaid, waived, released at a dissolve), so each
   contradiction's debt is exact from the ledger alone (`contradictionDebt`), however many there are. Bonus coins never repay it. Withdrawals are refused while anything is owed
   (`withdraw_not_allowed`, reason `amount_owed`; queued ones are held before sending); playing isn't.
   `GET /wallet` returns `owed: { amountKobo, reason: "duplicate_payout" }` (null when nothing is owed),
   for the app's "₦X owed from a duplicate payout. Contact support if this looks wrong." An admin can waive
   it: `payments.finalize`, a second admin, a reason (`owed_waivers`); the platform bears it
   (`payout_owed` ← `platform_funds`, oldest debt first, one journal per contradiction), never while any of
   the person's contradictions is still open (409 `contradiction_open`: a dissolve could otherwise return
   money the platform waived), never more than is still owed when it's confirmed, never by or for the
   admin themselves, all logged. The invariants check that what was booked as owed equals what the
   contradictions recorded at their freezes, that each person's hold equals the disputed amount of their
   contradictions still open, and that no owed account goes above zero and no hold below.
5. **Manual finalize and maker-checker.** For a stuck payout (`submitted`, `unknown`) or top-up
   (`pending`, `mismatch`, `expired`) an admin with `payments.finalize` sees a fresh provider check, then
   chooses success or failed with a required reason. The server asks the provider again at that moment and
   keeps its answer with the decision; it applies through the same locked transitions (a manual failed
   reverses once, a manual success settles or credits once). The answer is enforced, not just recorded:
   - a sent payout can't be finalized inside the resend window or the quiet period after its last send
     (`finalize.quietAfterSendMinutes`, default 30; 409 `finalize_too_soon`): a transfer still on its way
     looks "not found" or "pending";
   - one admin is enough only when the fresh answer is definite and agrees with the outcome and the amount
     is under the threshold; otherwise a second admin confirms whatever the amount, and both see why
     (`secondAdminBecause`: `check_not_definite`, `check_disagrees`, `amount_differs`, `over_threshold`);
   - a manual top-up credit uses the amount the provider verified as paid, never our requested amount; a
     different amount needs the second admin; with no verified amount there is nothing to credit (409
     `no_verified_amount`);
   - the second admin's confirm asks the provider again; if the answer has turned definite against the
     outcome (a "failed" payout now paid, a top-up's amount changed), the request is superseded, not applied.
   Nobody approves, finalizes or confirms their own transaction. All logged in `admin_actions` and
   `payment_finalizations`.
6. **Permissions.** The admin role stays one flag (`users.is_admin`); payments add four permissions per
   admin (`admin_permissions`): `payments.view`, `.approve`, `.finalize`, `.config`. Granting is loosening,
   so it's maker-checker (`payment_permission_grants`): a `.config` holder asks, a different `.config`
   holder confirms, and the grantee can never confirm their own grant; otherwise one admin could make a
   second account that passes every second-admin check. Nobody changes their own permissions. Revoking
   applies at once with one admin. Dev sessions and seeded dev admins hold all four. **Who is an admin at
   all** (`ADMIN_EMAILS`, and `DEV_ADMIN_HANDLES` in dev) **is controlled by whoever controls the
   environment**: none of these controls protect against them, so production secrets and deploys need
   their own two-person rule.
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
   succeeded, and recovered (a contradiction resolved) once and only then; a finished or cancelled party's
   pot is zero; and every platform account points its way (money in: `topup_in`, `dev_mint`,
   `bonus_issued`, `prize_funding`, `platform_funds`, `payout_owed` at or below zero; held or out: pots,
   `payout_pending`, `payout_settled`, `payout_fees` at or above). All reads run in one REPEATABLE READ,
   read-only snapshot. A breach is checked again in a fresh snapshot: only one that repeats raises its
   critical alert and pauses payouts until admins clear it (un-pausing takes two, see 10); one that
   doesn't repeat is a warning.
   **The invariants must never cause an endless outage:**
   - *Nobody can be placed.* When settlement finds nobody it can rank for prizes (every signed-up player
     banned mid-game, say) and the pot has money in it, the party is cancelled by the system and every seat
     refunded as it was paid; a banned player's entry goes to `entry_forfeited` instead, recorded with the
     ban (`entry_forfeits`). The pot is always empty when a party closes.
   - *Fees.* When the user bears the fee, they paid our estimate; the difference from what the provider
     actually charged goes to `fee_variance`, which may go either way (no direction rule). A platform-borne
     fee comes from `platform_funds`. Settles and resolved contradictions book fees through one function.
   - *Acknowledging.* An admin with `payments.config` can acknowledge a breach as it stands, with a reason; a
     second admin confirms (`invariant_acknowledgments`, logged). Each breach lists the items it's about
     (accounts, parties, providers, payouts) and how far off each is; one of the same kind whose items were
     all acknowledged at no smaller magnitude doesn't alert or pause again; a new item or a larger one
     does. Acknowledged breaches show on the payments page.
8. **Reconciliation and alerts.** Nightly per provider: our day's top-ups and withdrawals against the
   provider's lists; differences (missing ours, missing theirs, amount, status) go to a table and the
   console; nothing is fixed automatically (a confirmed missed top-up is replayed by an admin through the
   normal verify). Velocity alerts on withdrawals per hour (all, and per person). Alerts are rows deduped by
   key; pushing them to admins' phones is row 9.
9. **Webhooks** at `POST /webhooks/:provider`: authenticate first (Paystack: HMAC-SHA512 of the raw body
   in `x-paystack-signature`), store the raw event (one row per event; redeliveries counted), acknowledge,
   process in the worker. Exempt from the per-IP rate limit only. An optional allow-list of the provider's
   addresses (`PAYMENTS_WEBHOOK_IP_ALLOWLIST=true`). An event is marked processed only once it has had its
   effect; one that leaves its top-up still pending, or whose processing throws, counts an attempt and is
   retried by the sweep under a new job id; after `webhooks.maxAttempts` (default 50) it's dead-lettered
   with a warning alert (the top-up's own checks still run). A refused webhook (unknown or unconfigured
   provider, off the allow-list, bad signature) isn't stored as an event; it's recorded in
   `payment_webhook_rejections`: time, provider, source IP, reason and the first 500 bytes, never the whole
   body, at most 1,000 an hour, kept 30 days. The webhooks page shows the counts; at
   `webhooks.rejectionsAlertPerHour` (default 20) in an hour a warning alert fires, since a wrong secret
   after a key rotation fails every webhook at once.
10. **Loosening a control takes two admins.** A change to payments config or settings that loosens a
   control waits for a second `payments.config` holder (`payment_config_changes`, 202 from the PUT):
   raising a limit or threshold (including both maker-checker thresholds), lowering a minimum or a safety
   delay, switching either provider, un-pausing (the system's pause too), and any change to a field not
   listed as tightening in one direction. Tightening applies at once with one admin: pausing, lowering a
   limit or threshold. The config (or settings) row and its admin log entry are written in one
   transaction under one lock; a confirm whose "before" no longer matches the current config is
   superseded, never applied over a newer change.

## Consequences

- Every existing money path now writes two legs; readers that sum a party's money count people's accounts
  only (the pot mirrors them).
- Paystack refusals we can't be sure of (an unverified business, a duplicate reference, a bad key) are
  `unknown`, so such a withdrawal stays debited and alerts rather than being reversed by a guess; an admin
  finalizes it. Only an insufficient provider balance and a rejected recipient are definite failures, and
  only on a first send.
- Deleting an account now also waits for an open withdrawal (`withdrawal_in_progress`); `cash_balance`'s
  copy no longer says "contact support".
- The minimum withdrawal defaults to ₦1,000 (admin config). Paystack charged ₦10 to send ₦100 in test mode and
  the platform bears the fee by default, so below that the fee is too large a share of what moves.
- Checked against Paystack's test API (`npm run paystack:check`, 2026-11-02): checkout, verify (pending as
  "abandoned" before paying, then success with our reference, amount, currency and user id), not_found for
  an unknown reference, a ₦100 transfer that succeeded with `fee_charged` ₦10, and a resend of the same
  reference refused as a duplicate (mapped to unknown, so it is checked, not resent or reversed). Test mode
  did not refuse transfers before business verification; live mode may still require a verified business
  before it allows transfers (Paystack's "starter business" refusal), which the module treats as unknown.
- `/wallet/dev-topup` stays for local work and sims (minted against `dev_mint`; 404 unless
  `PAYMENTS_DEV_TOOLS=true`, and always in production).
- **Can a failed Paystack reference still be paid?** Yes, by Paystack's support docs: after a decline "the
  transaction can be completed using any of the other channels on the Paystack checkout form" and "the
  customer can retry the transaction at a later time"
  ([Bank errors](https://support.paystack.com/en/articles/2123650)). Reusing a reference for a *new*
  transaction is refused ("Duplicate Transaction Reference"), which is about starting, not paying. A
  third-party guide puts a checkout session's life at about 24 hours
  ([mctaba](https://www.mctaba.com/learn/paystack/paystack-transaction-status-values-and-what-each-means)),
  which our default cutoff matches. paystack.com/docs was behind a bot check when this was written, so this
  rests on the support article; `npm run paystack:check` now keeps verifying after a decline and reports
  whether "failed" then "success" came back for the same reference, to confirm it on the real test API.
- **Deploy hazard: 0021 needs every API and worker instance on the new code before it runs.** An old
  instance still running after it writes single-leg entries, which the invariants (rightly) flag as
  `entry_outside_journal` and pause payouts. Stop all API and worker instances, migrate, start them on the
  new code: no rolling deploy for this one (`docs/engineering/deploy-notes.md`). 0022 is additive, but ship
  it the same way since it lands with 0021.
- **Parties that straddle 0021** (a seat charged before double entry, refunded after) leave a pot that
  never received the entry, so it ends negative. No money was created. The pot invariants leave out any
  party with an entry from before double entry. In production there are none (0021 ships before launch).
  In the dev database (`contestly_pay`) they are the three seeded parties, all cancelled:
  `2f7c9040-42c6-48e8-9901-59812bbb5cdd` (Afrobeats 2010s throwback),
  `41d45f15-c722-41e6-8ed9-a40b8de4abc0` (Jollof Republic lunch break) and
  `2fec056f-82a3-4f73-a510-d691ec791d21` (Friday night football). Any other database migrated with
  pre-0021 parties has its own (`select distinct ref_id from ledger_entries where ref_type = 'party' and
  journal_id is null`).
- **Throughput.** `payout_pending` and `topup_in` are one row per provider, so every withdrawal and every
  top-up credit locks the same row and they run one at a time. This is speed, not money, and fine at
  launch volumes. If it bites, bucket the platform accounts (`scope` = `<provider>:<n>`, n from a hash of
  the transaction id; the invariants sum the buckets), with no change to the rules.
- **Read under the lock you journal under.** Every place that reads a balance or a debt and uses it to size
  a journal (audit 2026-11-03): `ledger.charge` (cash and bonus, locked by `lockUserAccounts`), the freeze's
  hold (cash, the same), the repayment (the owed account, locked `FOR UPDATE` first), the waiver (the owed
  account), the dissolve (owed account and hold, `lockPersonScoped`; it used to read the owed balance
  unlocked), and account deletion's bonus forfeit (it read the bonus unlocked; now `lockUserAccounts`, a
  one-line change in main's `deletion.ts`). Refunds, releases and forfeits size from earlier entries, which
  never change; settlement sizes from the party's own figures; contradiction resolution from its fixed
  amount. Balance reads elsewhere (wallet, `/me`, onboarding's can-afford, admin views, the
  `withdrawBlockReason` owed check outside a transaction) only display or pre-check; the transaction re-checks.
- **The lock order** for every money path (two paths taking the same locks in opposite orders deadlock):
  1. the person's `users` row, when the path locks it at all: `FOR NO KEY UPDATE` (`lockPerson`), unless the
     transaction changes a key column of it (email, handle), which needs `FOR UPDATE`;
  2. transaction rows: the party, or the payout / top-up / contradiction / waiver / finalization / grant;
  3. ledger accounts, inside `ledger.journal()`: the person's own and those kept per person (what they owe,
     what's held) first, then platform accounts, each group by id; cash credited to someone who owes locks
     their owed account up front for the repayment.
  A transaction that moves several people's money (settlement, a cancel's refunds) is serialised by the
  party row, and each journal in it follows 3. Audit (2026-11-03), every place a user row is locked:
  withdrawal request, send, every payout transition (applyOutcome, the freeze), approve, reject, finalize
  and its confirm, contradiction confirm, waiver request and confirm, top-up start, permission changes:
  person first, `NO KEY UPDATE` (changed in payments; tested). Account deletion and a guest's sign-up
  (`becomeMember`): `FOR UPDATE`, needed because they change the email; person, then accounts; deletion is
  refused while a withdrawal or a party is open, so it never meets a settle. Party join, leave, cancel,
  settle and refunds never lock a user row (party row, then accounts). Ban/unban, the Climb run start,
  About you and the streak lock a user row `FOR UPDATE` but move no money and wait for nothing after it, so
  they can't be in a cycle; `NO KEY UPDATE` would do for them, left as main's to change.
- A withdrawal request locks the person's row `FOR NO KEY UPDATE`, not `FOR UPDATE`: the worker settling
  their earlier payout holds `payout_pending` and updates that payout row twice in one transaction, and the
  second update's foreign-key check needs a key-share lock on the person's row. `FOR UPDATE` blocks that
  and deadlocked with the request waiting for `payout_pending` (found by `sim:payments`; a test reproduces
  the interleaving).
