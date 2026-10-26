# ADR 0007: One thread model for party chat, messages and crews; writes through the rooms

Status: accepted (Oct 2026). Row 6a, chat.

## Context

Chat has three surfaces with one composer: a party's room (lives while the party lives; during play
only on the standings beat), one-to-one messages, and crews (row 6b). All three need the same things:
text with @mentions, emoji, voice notes, unread counts, paged history, a per-user rate limit, and a
client message id so a retry never posts twice. Before this, `chat_messages` hung off `parties` and
only the party room wrote to it.

## Decision

- **One thread model.** `chat_threads` (kind `party` | `dm` | `crew`; a party has exactly one, a DM is
  keyed by the two user ids sorted, a crew has one), `chat_members` (who's in it, how far they've read,
  and for a DM recipient whether they've accepted a request), `chat_messages` (every line, keyed to its
  thread). Unread = lines after `last_read_at` that aren't yours. Party threads are made with the party;
  the host's team and every seat (guests too) are members.
- **One write path.** `postMessage()` in `packages/db/src/chat.ts` checks the thread's rules (member,
  message request limits, the voice note is the sender's and really uploaded), masks profanity, resolves
  @mentions to real handles, and inserts with `on conflict (user_id, client_msg_id) do nothing`: a repeat
  returns the first line. System lines go through `systemLine()`.
- **Writes go through realtime.** The party room sends lines for its party (it alone knows the beat, so
  standings-only is enforced there). A new `InboxRoom` (one per signed-up user, all their devices) sends
  to DMs and crews, and to a party thread from Chats › Parties only before the party and for
  `postGameChatHours` after it (never while it's live). Both rooms apply the rate limit first and ack the
  sender with `chat:ack`.
- **Delivery over Valkey.** Every line is published on `chat:thread:<id>`; the party room relays its
  thread, an inbox room relays the threads its client has open (`watch`). DM and crew lines also go to
  each member's `chat:user:<id>` so the Chats list and badge move live. Party threads don't fan out per
  member (hundreds per room); Chats › Parties refreshes over HTTP. Writers publish after commit.
- **Who may message whom** is one function, `dmPermission()` in `packages/shared`: direct when the
  recipient follows the sender (mutuals included), they finished a party together, or they share a crew;
  otherwise a message request (up to `requestMaxMessages` text lines, no voice, until the recipient
  accepts or replies); refused for guests, system accounts, and a brand writing to anyone who never
  joined its parties (brands never send requests). A decline holds until the recipient opts in (follows).
- **Voice notes never touch the API's body.** `POST /chats/:id/voice` checks the caps and returns a
  presigned PUT for `voice/<thread>/<note>`; the line is sent with the note id, and the room HEADs the
  object (exact signed length) before attaching it. Playback is a short-lived signed GET from
  `GET /voice-notes/:id`. The worker transcribes each note behind a `Transcriber` interface (mock until
  a provider is chosen) into `moderation_items`, which row 11 reviews. Unsent uploads are deleted after
  a day, sent notes after `voiceRetentionDays` (the line stays, marked expired).

## Alternatives considered

- **A table per kind** (party chat, DMs, crew chat). Simpler queries per surface, but three copies of
  the write rules, unread logic and paging: the rule-in-one-place principle loses.
- **Writes over HTTP** with the API publishing to Valkey. Easier retries, but party chat must be gated
  by the room's beat, which only the room knows, and the roadmap wants every room write to carry a
  client message id. Keeping all writes in realtime gives one gate and one ack path.
- **Fanning party lines out to every member's inbox.** Live party badges everywhere, at the cost of
  hundreds of publishes per line in a full room. Not worth it until people ask for it.

## Consequences

- `chat_messages.party_id` and `system` are gone (migrations 0009 and 0010 backfilled threads); the
  wire shape is `chatMessageSchema` in `packages/shared/src/chat.ts` (`kind`, `author`, `voice`,
  `clientMsgId`). Clients must send `clientMsgId` with every line.
- Blocks and mutes (row 11) add a refusal inside `dmPermission()` and `postMessage()`; reports join
  `moderation_items` with their own kind.
