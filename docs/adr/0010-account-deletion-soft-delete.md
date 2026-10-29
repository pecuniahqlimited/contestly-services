# ADR 0010: Account deletion is a soft delete

Status: accepted (2026-10-29). Store requirement (in-app account deletion); amends ADR 0006 rules 3 and 4.

## Context

Both stores require that people can delete their account from inside the app. We must also always be
able to trace an account: the ledger is append-only and points at users, prizes and disputes need to
know who was paid, and moderation needs to know who said what. So deleting can't erase the row.

## Decision

1. **`DELETE /me`, after a fresh re-verification.** A sign-in (email code, Google or Apple) that lands
   on the session's own account marks it for 5 minutes (`reverified:<userId>` in Valkey); the delete
   needs the mark (403 `reverify_required`). To allow it, `POST /auth/oauth/start` no longer refuses a
   signed-up session; `signIn()` still decides where any sign-in lands. `GET /me/deletion` tells the app
   the blockers and the window before it asks for anything. Optional reason from `DELETION_REASONS`.
2. **Refused while** there's cash (409 `cash_balance`, "Contact support to withdraw first", until
   withdrawals exist in row 10) or the person is seated in or hosting an open or live party (409
   `active_party`). Checked inside the delete's transaction, on the locked user row.
3. **One transaction, nothing that traces the account is erased** (`archiveAccount()` in
   `packages/db/src/deletion.ts`): `deleted_at`, `deleted_reason`; email, handle, name, face, bio and
   phone (number and hash) move to `archived_*` columns. The live email is cleared so it can sign up
   again as a new account; the live handle becomes `deleted_<id>` (a reserved prefix), the name
   "Deleted player" and a neutral face, so past chat lines, results and DMs render that with no rule per
   screen. Identities are kept and marked `disabled_at`; live identities are unique by a partial index
   (`user_identities` gets its own id), so the same Google/Apple account can belong to a new account.
   Bonus coins are forfeited by one `ledger.post` (`account_deleted:<id>:bonus`); no entry is touched.
   Crews are left as on leave (hand-over, archive if last). Device tokens are deleted here once row 9
   adds them.
4. **Relationships leave the live tables, records stay.** Follows (both ways) and crew invites (to or
   from them, any status) move to `archived_follows` and `archived_crew_invites`: the same columns plus
   `archived_at`, in the same transaction. No live query reads them; the admin detail does. Pending party
   invites to them are dismissed. Chat lines, voice notes, party seats, Climb history and feed rows stay.
   Weekly Climb prizes still pending, or approved and held unpaid, become `void` (approve and reject
   then refuse them with `award_void`; `canBePaidCash()` refuses a deleted account too), each logged in
   `admin_actions` as `climb.award_void` with reason `account_deleted` and the system account as the
   actor, since no admin made the decision. Paid and rejected prizes are untouched. A Climb run in progress
   ends as `abandoned`.
5. **After it commits:** the user leaves the Everyone board, open rooms drop them (`user_deleted` on
   the admin events channel, `account_gone`), and the Firebase user is disabled, not deleted. A failure
   there is logged; the session is already refused because no live identity reaches the account.
6. **Excluded everywhere else** with one predicate, `liveUser` (`users.deleted_at is null`): session
   resolution (`account_gone`, including a signed-up guest's leftover anonymous token), profiles, follow,
   DMs and Challenge (404), the DM rule (`dmPermission` refuses a deleted recipient), mentions, invites,
   contacts, the Everyone, friends and crew boards, Climb week close, the feed, "played with".
7. **Admins see everything.** Search matches archived email, handle, name and phone (and id); rows show
   what the account was and `deletedAt`; the detail shows the deletion, the archive, and the archived
   follows and crew invites with the person on the other side. Every admin view
   of a deleted account is logged (`user.view_deleted`). No restore for now.
8. **Retention.** The worker's daily `purge_deleted_archives` clears the archive's personal fields
   (email, phone and hash, name, face, bio, About you answers) once `deletedArchiveRetentionDays` has
   passed, keeping the row, its id, the archived handle and the ledger, and sets `archive_cleared_at`.
   The period is `null` (off) until the privacy policy sets it (`PUT /admin/accounts-config`, logged).

## Alternatives considered

- **Hard delete with anonymised ledger rows.** Breaks the append-only ledger and loses who was paid.
- **Keep identities unique and refuse re-sign-up.** People who delete and come back would be stuck, and
  stores expect a deleted account to free its sign-in.
- **Keep follows and filter them everywhere.** A dozen follow queries would each need the rule, and
  missing one shows a deleted person. Moving them to an archive table keeps the trace without that.
- **Delete follows and invites outright.** The first version did; it lost who the account was connected
  to, which support and disputes can need.
- **Delete immediately, restore within a grace period.** Not needed yet; the archive keeps the option.

## Consequences

- Any new query that finds, lists or reaches people must use `liveUser` (or join through something a
  deleted account has already left, like follows).
- A deleted account's number can be verified by a new account; the old hash stays in the archive until
  retention clears it.
- Row 10 replaces the `cash_balance` refusal with a withdraw-first flow; row 9 deletes device tokens.
