# ADR 0019: Challenges, made through party creation

Status: accepted (10 Nov 2026). Replaces the one-tap `POST /users/:id/challenge` from row 6b.

## Context

The one-tap challenge made a fixed party: free, private, the lanes you share, starting at the default time, with nothing for the challenger to choose. It also started on the clock whether or not the other person had answered. A challenge should be a party like any other (topics, files, formats, stakes) that starts when the people in it are ready, not at a fixed time.

## Decision

1. **A challenge is a party.** `POST /parties` takes `challenge: { invitees, inviteExpiresInMinutes, joinWindowMinutes, message? }`, so it gets everything the builder offers. `GET /challenges/preset?userIds=` makes nothing; it returns the builder's defaults:
   - suggested topics (lanes you share, the last party you played together, the invitees' recent categories);
   - 5 questions, free, private, sealed;
   - the expiry and join-window defaults and ranges;
   - whether each person can be challenged.
   The rest of the challenge lives in `party_challenges` and `party_challenge_invitees`; `parties` is unchanged.
2. **What a challenge allows:**
   - The challenger plays: sealed only. A brand can't challenge, a curate set or host-written questions are refused, and so are crew parties and the builder's own invite list (`challenge_not_allowed`, with the reason).
   - Stakes are an equal pooled entry or nothing; host prizes and goods are refused.
   - A challenge is always private, so it never posts to a corner.
   - Seats are the challenger plus the invitees, or the party limits' minimum if that's more.
3. **Who can be challenged:**
   - The DM rule decides: anyone `dmPermission()` doesn't refuse, which already covers blocks either way.
   - Brands, guests and banned accounts are refused too (`cannot_challenge`, naming the person).
   - A refused invitee refuses the whole party, so nothing is half made.
4. **Ranges are admin config** (`app_config` "challenges", `GET/PUT /admin/challenges/config`, logged with a reason):
   - invite expiry 60–2,880 minutes, default 1,440;
   - join window 5–60 minutes, default 10.
   A value outside them is `challenge_out_of_range`. Sends are limited per Lagos day by the existing `challengesPerDay`.
5. **The card.** Each invitee's DM thread gets a party card carrying the message, profanity masked. The party's own chat opens with who challenged whom ("Ada challenged Kemi and Tolu", `challengeOpeningLine()`), not the private party's share line. A stranger gets it as a message request, as before. `GET /challenges/:partyId` gives the card's state from the viewer's side:
   - pending, with time left;
   - accepted, with the join countdown and who's in the lobby (real presence only);
   - live or finished;
   - expired, declined or cancelled;
   - left, when the viewer accepted and then left.
   Each invitee's answer is pending, accepted, declined, expired (the invite ran out, or they weren't in the lobby at the window's end) or left.
   `GET /parties/:id` (which the lobby and the result read too) carries `challenge: { state, cardUrl }` with the same state from the viewer's side and the card's API path, or null for an ordinary party, so the app never probes the card (amended 11 Nov 2026).
6. **Answering:**
   - **Accepting** (`POST /challenges/:partyId/accept`) takes a seat through `takeSeat`, so an entry is charged here as for any join. The first accept opens the join window and moves `startsAt` to its end. Until then a challenge has no start time: every party row carries `startsWhen`, `on_accept` for an open challenge nobody has accepted (its `startsAt` is only the latest it could start), `scheduled` otherwise (amended 11 Nov 2026; a marker rather than a null `startsAt`, so no party card in the app has to handle a missing time). `POST /parties/:id/join` refuses a challenge (`challenge_accept_required`), and so do extra invites.
   - **Declining** (`/decline`) writes "Not this time" on the invitee's card in the DM. Once nobody is left pending or accepted, the party is cancelled and refunded.
7. **Starting:**
   - **Early start:** a challenge starts as soon as nobody is still pending and every seated player is in the lobby. The room queues a check on every join; a decline, and an invite expiring, queue one too.
   - **At the window's end:** the usual `startOrCancel` runs, and invites still pending expire. It goes ahead only if at least two seated players are in the lobby; then every seated player who isn't is refunded and unseated ("<name> didn't make it", their answer expired). Otherwise it's cancelled with "Challenge expired." and everyone is refunded.
   - **The challenger** counts like anyone (amended 10 Nov 2026): absent at the window's end, they're just another no-show, and the game goes on without them if two others are in.
   - **Expiry:** if nobody accepts before the invite expires, the expiry job cancels the party with "Challenge expired." The minute sweep is the backstop, because `startsAt` starts at expiry plus the window.
   Every cancel goes through `refundAndCancel()`, so every seat is refunded the way it was paid.
8. **Nudges, through the engine and its rules:**
   - `challenge_received` (people): push only, since an open app already shows the DM card.
   - `challenge_accepted`: to the challenger, "Join the lobby".
   - `challenge_join_reminder`: at the window's halfway point, to anyone seated or still pending who isn't in the lobby.
   The last two are live-party events, like starts-in-5.
9. **After the game:** results feed the head-to-head as before. A rematch of a challenge is a new challenge with the same settings, to the other players who aren't a guest and can still be challenged.

## Consequences

- The app's Challenge button opens the builder with the preset, not a one-tap send, and the card reads `GET /challenges/:partyId`.
- Presence decides an early start, so it relies on the room's `party:here` counts; a lost check is caught at the window's end.
- An acceptor can still leave through `/leave` until the usual 2-minute lock, with their entry back. The card shows them as left, they can't accept again, and the start goes on without them (a leave queues the early-start check). If nobody else is still pending or accepted, it's cancelled at once with "Challenge expired."
