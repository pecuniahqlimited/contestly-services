# ADR 0006: Anonymous-first accounts, signed in from a WebView

Status: accepted (2026-10-22). Roadmap row 5, Firebase Auth and onboarding.

## Context

Onboarding is a game played before sign-up, so the server must know who is playing from the first
screen. Sign-in is Google, Apple (iOS) or a 6-digit email code: no passwords, no links, nobody leaves
the app. The new app is a web build served at play.contestlyapp.com inside the existing Capacitor
shell (WKWebView / Android WebView), which has no native Google or Apple plugin, so Firebase's popup
and redirect sign-in flows aren't usable there. Production uses the existing Contestly Firebase
project, which today serves only push (FCM); the current app signs in with Supabase, and row 11b
will migrate those users.

## Decision

1. **Firebase is only a session issuer.** It issues anonymous sessions and verifies the ID tokens of
   sessions it issued; every other sign-in ends with a custom token we mint. We never use Firebase's
   own providers, never set custom claims, and never touch the project's FCM setup or its
   account-linking setting. The project is config (`FIREBASE_PROJECT_ID`, a service account secret);
   local work and the sims use the Auth emulator.
2. **Every session starts anonymous.** The first API call from a new anonymous uid creates a `users`
   row with `is_guest`. Guests play the onboarding round, free parties they were invited to, and Climb
   runs; they can't hold coins, appear on boards or profiles, win, host or move money
   (`sign_up_required`).
3. **Identities are `(provider, external_id)` → user** (`user_identities`). `firebase` is the session
   uid; `google` and `apple` are the provider's subject from our own OAuth flow. Row 11b adds
   `supabase` (the old user id) the same way, and the Supabase-session exchange mints a custom token
   for the imported account (its uid is its own id until it has one). One account per verified email
   (`users.email`, lowercased, unique).
4. **Google and Apple run over the system browser**, the same pattern the current app uses:
   - `POST /auth/oauth/start` (as the guest session, with the app's PKCE challenge) returns our
     provider URL; the app opens it with `@capacitor/browser` (a plain redirect on the web).
   - The provider returns to our callback (Google: GET; Apple: form POST). We check its ID token
     (signature, issuer, audience, nonce) and send the browser back to an allow-listed return URL
     (`contestly://auth` or `https://play.contestlyapp.com/auth`) with a random one-time code. The
     callback only stores the verified identity next to that code; no account changes yet.
   - `POST /auth/exchange { code, verifier }` works once, within 60 s, only from the session that
     started and only with the right PKCE verifier. Then the sign-in is decided (rule 5) and we return
     a Firebase custom token. An intercepted deep link is useless without the session and verifier.
5. **Which account a sign-in lands on** (same rule for the email code and Google/Apple):
   the identity is already an account's → that account; else the verified email is an account's →
   that account (the identity is attached); else the session is a guest → the guest signs up (same
   row, nothing copied or merged); else → `sign_out_first`. The custom token is always for the
   session's own uid (the guest's anonymous uid, kept when it signs up) or the existing account's uid,
   never for some other Firebase user found by email. An existing account never takes the guest's
   coins; the guest row is left as it is.
6. **The email code** is 6 digits, stored in Valkey as an HMAC with a server secret, bound to the
   session that asked, alive 10 minutes, 5 tries, a new one after 30 s, rate-limited per email and IP.
7. **Onboarding coins wait on the round** (`onboarding_rounds`) until sign-up, then post as bonus with
   ledger key `onboarding:<normalisedEmail>` (lowercase; Gmail dots and +tags dropped). The device
   check (`onboarding_devices`) is best-effort: the iOS vendor id resets when the app is reinstalled,
   and a keychain or ANDROID_ID value can be wiped or spoofed. The email key is the real guard.
8. **Signing up pays what was waiting.** `becomeMember()` claims the coins and pays approved, unpaid
   Climb awards through `approveAward()` in the same transaction. `canBePaidCash()` = signed up with a
   verified email; `canWithdraw()` adds a verified phone (row 10 calls it).
9. **Phone is verified, not linked.** We don't offer phone sign-in, so the number is an attribute: the
   app verifies it with Firebase SMS on a secondary Firebase app instance and posts that ID token; the
   API reads the number, keeps it (E.164) for payouts, and deletes the throwaway Firebase user.
10. **Contacts are matched, not stored.** The app sends SHA-256 of each E.164 number; we keep
    `HMAC(PHONE_HASH_SECRET, sha256)` for people who added a number and compare the same way. A
    hash of a phone number is guessable, so the protections are that nothing sent is stored, only
    people who added a number can be found, and lookups are capped (1,000 per request; 2 syncs and
    2,000 hashes per user per day).
11. **Dev mode can't ship.** `AUTH_MODE=dev` (the `x-dev-user` header, and stand-in Google/Apple
    pages) refuses to start when `NODE_ENV=production`; in firebase mode the header is ignored.

## Alternatives considered

- **Sign-up first.** A form in front of the game, the opposite of the agreed flow.
- **A local guest id until sign-up.** Realtime and the API would need a second credential, and
  signing up would copy rows between users: the merge we want to avoid.
- **Firebase's Google/Apple providers (popup, redirect, `linkWithCredential`).** Don't work in the
  WebView without a native plugin and a store release, and would tie us to the live project's
  account-linking setting.
- **Native sign-in plugins in the shell.** Possible in the one shell update before cutover, but the
  browser flow works today and on the web; a plugin can later feed the same exchange.
- **Linking the phone credential.** Makes phone a sign-in method, which we don't offer.

## Consequences

- Anonymous Firebase users accumulate. A cleanup job (delete anonymous uids of guest rows idle for N
  days, and those rows) is a follow-up; it must only touch uids in `user_identities`.
- An abandoned guest row keeps any free-party seat it had; it never shows on boards or profiles.
- Google and Apple each need our callback URL registered; Apple needs a Services ID and a key.
- Row 11b plugs in as one more identity provider and one more exchange endpoint; nothing here moves.
