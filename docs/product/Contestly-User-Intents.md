# Contestly User Intents

11 Oct 2026 · Solomon

Doc: https://claude.ai/code/artifact/df051d87-b630-40cc-b686-4498130527a8

## How to read this

This is the complete list of what a person can set out to do in Contestly, as designed in the prototype and CLAUDE.md as of 11 Oct 2026. Each intent is written as "As a [actor], I want to [do X] so that [outcome]", with the acceptance rules the architecture must support and the system capabilities it touches. It is the input for the platform and solution architecture; it does not prescribe tables, services or APIs.

**Actors**

| Actor | Who | Can |
| --- | --- | --- |
| Visitor | Opened the app or an invite link, no account | Browse the welcome, join a free party as a guest |
| Guest | Visitor playing a free party under a display name | Play and chat in that one party; no score kept, no prizes, no coins |
| Player | Signed-up person on their personal profile | Everything below except brand-only actions |
| Host | A player who created a party | Configure, invite, advance rounds, see the Forge |
| Brand | A verified business profile run by one or more players | Host parties with cash, product or experience prizes; message players who joined its parties; never joins as a player |
| Brand team member | A player attached to a brand with a role | Host on the brand's behalf; the brand is shown as host, the person is recorded |
| Admin | Internal | Verification review, question bank, flags, configuration; out of scope here |

**Scope.** Two game modes (Party, The Climb), the social layer, accounts and money. Admin tooling, analytics and marketing surfaces are not covered. Every intent below has a corresponding screen or state in the prototype (`Prototype.jsx`, UI flow tab).

## 1. Entry and onboarding

Onboarding is a 90-second game that ends on Home. Three entry states decide what the visitor sees first.

| # | Intent | Acceptance rules | Touches |
| --- | --- | --- | --- |
| 1.1 | As a visitor, I want to understand what Contestly is in one screen so I can decide to jump in | Welcome shows the brand, one line, three mode rows, Jump in. Never leads with money paid out, pots or "win cash" | App shell |
| 1.2 | As a visitor with an invite to a free party, I want to join as a guest with just a name so I can play without signing up | Allowed only when entry is 0 and there is no cash to be won. Guest plays and chats; score not saved; not eligible for prizes; persistent sign-up nudge in lobby and on result | Invite links, party rules, guest session |
| 1.3 | As a visitor with an invite to a staked party, I want to sign up and land in that party so I can put my stake in | Required when entry > 0 or a cash prize exists. Welcome says why in one line. Sign-up ends in that lobby, auto-joined if coins cover the entry | Invite links, onboarding, wallet |
| 1.4 | As a visitor, I want to say whether I'm a person or a brand so the rest of onboarding fits me | Two tiles. Brand path gets brand picks and the verification checklist afterwards | Accounts |
| 1.5 | As a new player, I want two quick timed picks about me (lanes, multi-select; why I'm here) so the app knows my interests and archetype without a form | No pick is asked twice. Lanes seed interests; "why" seeds the archetype (competitor / host / grinder / fan). Editable later from Me | Profile, recommendation |
| 1.6 | As a new player, I want to be told plainly that the next round earns coins and what they're for before I play it | Bridge screen names the target (first party / first pot) and the reward tiers | Onboarding copy |
| 1.7 | As a new player, I want to play three quick-fire questions where right and fast earns coins so my first coins feel earned | Server-timed. Points to coins by tier (e.g. 800+ pts to 500 coins). If others are onboarding at the same time we share a round and see a leaderboard; alone I still play and get the solo tier. Never claim someone is online who isn't | Game engine, matchmaking, ledger |
| 1.8 | As a new player, I want to keep my coins and profile in 10 seconds without leaving the app | Google, Apple (iOS) or email + a 6-digit code typed in the app; no links, no passwords. Coins credited on success, idempotently, once per normalised email and device | Auth, ledger |
| 1.9 | As a new player, I want to see which contacts are already here and follow them in one tap, with brands in my lanes pre-followed | Contacts only on request; matched by phone hash against people who added a number. Optional "add your number so friends can find you" on the same screen. Honest empty state when nobody matches. Brand pre-follow is reversible on the same screen | Contacts, follows |
| 1.10 | As a new player, I want to set a name and @handle and go straight to Home | Handle is unique and is the @mention token. No "first move" screen; Home already recommends | Profile |
| 1.11 | As a new brand, I want to finish verification after naming my brand so I can host with real prizes | Checklist: registration number, logo, site or social, business email; payout account only for cash prizes. Can host with coins before verified; cash and product prizes unlock on approval | Brand verification, review queue |
| 1.12 | As a returning person, I want "I have an account" to take me straight to sign-in | The same Google / Apple / email-code screen | Auth |
| 1.13 | As a player with winnings, I want to withdraw them safely | A verified phone number is required before the first cash withdrawal, one per account | Auth, wallet |

## 2. Home and discovery

Home is one card and one bar: the mode I'm in, what's happening, what to tap. It never scrolls into a feed and is never blank.

| # | Intent | Acceptance rules | Touches |
| --- | --- | --- | --- |
| 2.1 | As a player, I want Home to open on the mode that fits me so I don't have to look for it | Archetype only decides what's first (grinders open on The Climb; brands see Host only). Everyone can switch Party / Climb with one toggle | Recommendation |
| 2.2 | As a player, I want the Party card to tell me what to do now, in my situation | Copy per archetype (competitor: "Settle it" / Challenge a rival; host: "Get your people together" / Start a party; fan: lane brand hosting tonight). No single party is promoted on the card unless I'm in it | Recommendation |
| 2.3 | As a player with nothing open, I still want a move | Pill reads "No parties open"; actions become Start a party and Invite friends; Today's challenge and The Climb remain | Recommendation, fallback |
| 2.4 | As a player who joined or is hosting a party, I want Home to become that party | Four states by time to start: later (friends' faces, Remind me, Invite, Open the lobby), soon (<15 min), starting (≤2 min, green, live countdown, Enter the room), live (Join the round straight into the question). "+N more parties you're in" opens Chats › Parties | Party state, scheduling |
| 2.5 | As a player, I want to see when a party near me is filling up so I can get in before it starts | "Filling up" nudge on Home and badge in Parties when ≥60% full and <10 min to start | Recommendation, live counts |
| 2.6 | As a player, I want today's free challenge one tap away and to know if I've done it | Green quest bar when not done (who leads my friends); dark with tick and reset countdown when done | Daily challenge |
| 2.7 | As a player, I want three lines of what my friends did recently | Tappable; "All" opens Chats › Activity. Never leads with winnings; says "cleared stage 3", "beat Chidi", "scored 4/5" | Activity |
| 2.8 | As a player, I want to browse open parties ranked for me and filter them | Parties tab: For you, Following, Brands, Free entry, Starting soon; search across parties, people, brands | Recommendation, search |
| 2.9 | As a player, I want to say "not interested" on any party and have fewer like it | × on the card; the signal sticks per user and lowers that category/host | Recommendation |
| 2.10 | As a player, I want to see people and brands worth following under the parties list | Suggested from lanes, mutuals and lane brands | Recommendation |
| 2.11 | As a player, I want my streak, level and wallet visible at the top of Home without clutter | Level ring (XP), streak chip (opens leaderboard), bell (opens Chats › Activity), wallet pill (coins and cash) | Profile, ledger |

## 3. Party creation

Creation is a six-scene builder, not a form, and ends with the questions being generated in front of the host.

| # | Intent | Acceptance rules | Touches |
| --- | --- | --- | --- |
| 3.1 | As a host, I want to name my party and describe it in my own words, or attach a file, and have the questions made from that | Free text of any length and/or PDF, DOCX, slides, photos of notes. No category picker; the engine infers topic, audience and tone and reads a one-line summary back. A category tag is still derived for discovery | Question engine, file parsing (text + OCR), storage |
| 3.2 | As a host, I want a live poster that fills in as I type so the party feels real before it exists | Poster shows name, brief, count, difficulty, pace, AI tag, cover colour | UI only |
| 3.3 | As a host, I want to set difficulty, seconds per question, how many questions and which formats are allowed | Difficulty easy / mixed / hard / brutal; pace 8–20s; count 5–20; formats pick one, pick all that apply, put in order, match pairs, picture round. At least one format | Question engine config |
| 3.4 | As a host, I want to choose whether I play or only host, and understand the consequence | Playing = sealed: I never see the questions, generated at start. Hosting only = curate: I review every question and cannot play. Anyone who has seen a draft is barred from playing that party | Party rules, question engine |
| 3.5 | As a host, I want to set the stakes: everyone chips in, or I put up the prize | Pooled: entry 100–2,000, seats 4–50, split winner-takes-all / 70-30 / 60-30-10, pot shown. Host-funded: cash amount from my cash balance, or a product or experience with a description and approximate value, one winner, free entry, seats up to 100 | Ledger, prize fulfilment |
| 3.6 | As a brand, I want to give away a product or an experience rather than cash | Needs a verified brand to publish; winner and brand are messaged to arrange delivery within 7 days; status tracked | Brand verification, fulfilment state machine |
| 3.7 | As a host, I want to decide who can join and pick a cover | Public (listed, followers pinged) or private (link only); colour or photo | Visibility, uploads |
| 3.8 | As a host, I want to watch the questions being forged so I trust them, even when I'm not allowed to see them | Deck of cards fills one by one with the pipeline stage named (reading, drafting, checking, dedupe, balance). Sealed: cards face-down with lock and format icon. Curate: cards flip; approve, un-approve, swap per question; at least 3 approved to publish | Question engine progress events |
| 3.9 | As a host, I want to open the party and have my followers told | Publish creates the party, enqueues follower alerts, invites any named rival, and lands me in the lobby with the invite sheet open | Party service, notifications |
| 3.10 | As a new host on my first party, I want my first small pot funded so I can try hosting | ₦2,000 sponsored pot, free entry for contacts, once | Promotions, ledger |
| 3.11 | As a player on someone's profile, I want to challenge them and have the party pre-filled | Title "Me vs X", brief seeded from my lane, they're invited on publish | Party creation, invites |

## 4. Party lobby and gameplay

Every round is three beats on a server clock: question, reveal, standings. Chat is open only on standings and in the lobby.

| # | Intent | Acceptance rules | Touches |
| --- | --- | --- | --- |
| 4.1 | As a player, I want to see what a party is before I join: host, pot or prize, seats, start time, who I follow that's in, and that the questions are AI-made | Lobby header, stats row, members row, pill "AI questions · sealed / host-reviewed" | Party read model |
| 4.2 | As a player, I want to join and pay from coins first, then cash, with a clear confirmation | Confirm sheet shows entry, source, prizes, refund rule. Join locks the party row; full party cannot be oversubscribed; replay is a no-op; insufficient funds routes to top up | Ledger, concurrency |
| 4.3 | As a guest, I want to be in the lobby and play without an account | Banner states guest limits; Sign up link; result screen repeats the offer | Guest session |
| 4.4 | As a player in a lobby, I want to chat with @mentions, emoji and voice notes, and invite people | Composer shared with DMs; voice notes capped and stored; invite sheet with share targets and people I follow | Chat, media storage, share links |
| 4.5 | As a host, I want to follow or be followed from the lobby, and players to follow me | Follow button beside host name | Follows |
| 4.6 | As a player, I want each question delivered to everyone at once with a visible clock | Server opens and closes rounds; client shows server-synced timer; A–D coloured tiles for pick-one and picture; dedicated UIs for pick-many, order, match | Game engine, realtime |
| 4.7 | As a player, I want to change my answer until time runs out | Selection changeable until the clock ends; no Lock in; whatever is selected at the end is the answer (or no answer); the speed bonus uses the time of the final change; the question always runs its full length | Game engine |
| 4.8 | As a player, I want to be scored on correctness and speed, with partial credit where it applies | Base + speed bonus from server open time; pick-many: right minus wrong over total; order and match: per position/pair | Game engine |
| 4.9 | As a player, I want to see the answer, my pick, my points and how the room answered right after each question | Reveal: verdict card (Correct +N / Partly / Not this one / No answer / Voided), correct option highlighted, "Your pick" marker, per-option distribution bars and %, "N didn't answer". Distribution and correct index are null until the round closes | Game engine, reveal payload |
| 4.10 | As a player, I want to know why the answer is right without it taking up the screen | Explanation behind an ⓘ, opens a sheet; marked AI-generated and fact-checked | Question engine |
| 4.11 | As a player, I want to see standings after every question, animated so I can feel myself move | Top-5 ladder animates from `prev_rank` sent by the server; ▲/▼ deltas; my row pinned below with gap to 5th if outside; reduced motion cross-fades | Game engine, realtime |
| 4.12 | As a player, I want to chat on the standings screen only, live-stream style | Pinned composer, last three messages floating; chat closed during question and reveal; thread persists in the room | Chat gating |
| 4.13 | As a host, I want to move the room on when everyone has seen the reveal or standings | "Show standings" after a 3s floor; "Next question" on standings; all later rounds shift by the saved time in one transaction | Scheduling |
| 4.14 | As a player, I want to flag a bad question and have it fixed for everyone | Reasons: wrong answer, more than one right, unclear, out of date, inappropriate. Past a threshold the engine voids it for the room, removes it from scoring, appends a verified replacement, retires it from the bank pending review | Question engine, realtime |
| 4.15 | As a player, I want a result screen that settles the money or the prize and lets me act | Final board; cash prizes credited to cash balance; non-cash prize starts fulfilment with both sides messaged; voided count shown; Share, Rematch, follow who you played | Ledger, fulfilment, share |
| 4.16 | As a player, I want a rematch with the same people in one tap | New party cloned, everyone invited, chat seeded | Party service, invites |
| 4.17 | As a player who dropped off, I want to rejoin the round in progress | Reconnect token re-enters the room at the current beat | Realtime |
| 4.18 | As a player, I want a party that doesn't fill to refund me | Under 2 players at start: cancelled, entries and host pot refunded with idempotent ledger entries | Worker, ledger |

## 5. The Climb

A free solo ladder of N stages (config in the database, edited by an admin). Every run starts at stage 1; a run ends when you miss a stage or clear the last one.

| # | Intent | Acceptance rules | Touches |
| --- | --- | --- | --- |
| 5.1 | As a player, I want to see the ladder and my week before I play | Climb home: today's best, all-time best run, the stage ladder with each stage's game type, Today's challenge, this week's days played / stages / points / friends rank, my Everyone rank and the gap to the prize line, my week by day, my records | Config, scores |
| 5.2 | As a player, I want to climb as often as I like, free | No entry, no seats, no walk-away. Only my best run each day counts | Game engine |
| 5.3 | As a player, I want short puzzle rounds of different kinds | Pattern, scramble, word hunt, quick maths, memory; each stage allows one or more types and a round picks one; generated and graded on the server, answers kept until the round closes | Game engine |
| 5.4 | As a player, I want to clear a stage by getting enough rounds right | Rounds per stage (default 3), rounds to clear (default 2, the last stage 3), seconds per round, all config. Missing the mark ends the run; stages already cleared keep their points | Game engine, config |
| 5.5 | As a player, I want points that add up across the week | Run = sum of cleared stages' points (default 10/20/30/40/50). Day = best run that Lagos day. Week = sum of daily bests plus Today's challenge, Monday–Sunday | Scores, leaderboard |
| 5.6 | As a player, I want a daily quiz that's the same for everyone | Today's challenge: written by an admin, off unless scheduled for the day; one go; options shuffled per player; 8 s a question; up to +100 points | Today's challenge |
| 5.7 | As a top player, I want the week's prize when I place | At week close the top X on Everyone (admin config, default 10) become pending awards; an admin approves; cash goes to my cash balance through the ledger. Only signed-in accounts are paid; otherwise the award waits | Worker, ledger, admin |
| 5.8 | As a player, I want to share a good run | Share card leads with the climb (stages, points), never an amount | Share |

## 6. Daily loop and progression

| # | Intent | Acceptance rules | Touches |
| --- | --- | --- | --- |
| 6.1 | As a player, I want a free daily challenge, the same for everyone, so I can compare with friends | Today's challenge (5.6): admin-written, 8 s a question, resets at Lagos midnight, up to +100 Climb points; no coins | Today's challenge, leaderboard |
| 6.2 | As a player, I want to dare friends with my score | Share card hides the score until the friend plays | Share |
| 6.3 | As a player, I want to keep a streak and know when it's at risk | Streak = consecutive Lagos days with a Climb run; at-risk nudge 3h before midnight | Streaks, nudges |
| 6.4 | As a player, I want a friends-first weekly leaderboard with the gap to the next rank | Friends by default, Everyone behind a tab (crews in row 6); Monday–Sunday, Lagos time; points from Climb daily bests plus Today's challenge; weekly prizes from Everyone only; my row pinned; challenge from any row | Leaderboard |
| 6.5 | As a player, I want to level up from play | XP from daily, parties, stages; level ring on Home | Profile |
| 6.6 | As a player, I want missions that pay coins | Daily and weekly; progress visible; claim on completion | Missions, ledger |
| 6.7 | As a player, I want badges for milestones | Earned on events; shown on profile | Profile |

## 7. Social

Chats is a top-level tab (Home · Parties · + · Chats · Me) holding Messages, Crews, Parties and Activity.

| # | Intent | Acceptance rules | Touches |
| --- | --- | --- | --- |
| 7.1 | As a player, I want to follow people and verified brands, and unfollow | Follow is public; counts on profiles | Follows |
| 7.2 | As a player, I want per-person party alerts I can turn on or off | Bell on a followed profile; on by default on follow | Follows, nudges |
| 7.3 | As a player, I want to open anyone's profile from anywhere their name or face appears | Feed, chat, @mentions, lobby, results, leaderboard, activity, lists | Profiles |
| 7.4 | As a player, I want to see my head-to-head record with someone and challenge them in one tap | H2H from shared party results; Challenge pre-fills creation | Stats, party creation |
| 7.5 | As a player, I want to see who I follow that also follows someone (mutuals) and a person's open parties, activity and badges | Profile tabs; brands show parties hosted and prizes given instead of H2H | Profiles |
| 7.6 | As a player, I want to message a person with text, emoji and voice notes | One-to-one threads; same composer as party chat; Challenge from the thread header | DMs, media storage |
| 7.7 | As a player, I want party chat to work before, during (standings only) and after the party | Thread lives in the room; reachable from Chats › Parties | Chat gating |
| 7.8 | As a player, I want to @mention someone and have them notified | Autocomplete from room members; mention nudge batched per thread | Chat, nudges |
| 7.9 | As a brand, I want to message players who joined my parties, and not cold-message anyone | Enforced server-side | DMs, brand rules |
| 7.10 | As a player, I want to share a party invite, a result or a profile to WhatsApp, Status, Instagram or by link | Deep links carry the inviter; a shared party opens the invite entry state | Share links |
| 7.11 | As a player, I want a referral code that rewards me and my friend | 200 coins each once the friend plays | Referrals, ledger |
| 7.12 | As a player, I want to see my followers and following lists and follow from them | Lists on my profile and others' | Follows |
| 7.13 | As a player, I want to block, mute or report a person or a party | Reports go to a moderation queue; blocked users can't message or join my private parties | Trust and safety |

## 8. Accounts, brands and money

| # | Intent | Acceptance rules | Touches |
| --- | --- | --- | --- |
| 8.1 | As a person, I want one login with a personal profile and any brand profiles I run, and to switch between them | Switcher on Me; acting profile shown; brands host only | Accounts, sessions |
| 8.2 | As a person, I want to create a brand later from my personal profile | Goes through the brand onboarding and verification | Accounts |
| 8.3 | As a brand owner, I want to invite teammates by username or phone and give them a role | Teammates host as the brand; the brand is shown as host and the person is recorded | Brand team, roles |
| 8.4 | As a brand, I want to know my verification status and what's missing | Checklist with status pill; badge on profile once approved | Verification |
| 8.5 | As a player, I want to see coins and cash separately and understand the difference | Coins: for entries, never withdrawable. Cash: winnings, withdrawable. Entries drain coins first, then cash | Ledger |
| 8.6 | As a player, I want to add coins | Paystack top-up via verified webhook, idempotent | Payments |
| 8.7 | As a player, I want to withdraw cash to my bank | Payout rail pluggable per platform: bank transfer on iOS/web, vouchers or airtime on Android | Payments, policy |
| 8.8 | As a player, I want a full history of entries, wins, refunds and top-ups | Append-only ledger shown as history | Ledger |
| 8.9 | As a winner of a non-cash prize, I want to arrange delivery with the brand and confirm receipt | Status: awarded → arranged → delivered / disputed; nudges on day 3 and 7 | Fulfilment, nudges |
| 8.10 | As a player, I want to edit my interests, name, handle and photo | From Me | Profile |
| 8.11 | As a player, I want to control which notifications I get | Per-category toggles | Notification preferences |

## 9. Notifications

Every nudge is a worker-emitted event delivered as push when the app is closed and as an in-app banner when open, with identical content and deep link.

| # | Intent | Trigger | Rule |
| --- | --- | --- | --- |
| 9.1 | As a player, I want to be told 5 minutes before a party I'm in starts | T-5 for joined or hosted parties | Always; also T-1 if not in the room |
| 9.2 | As a player, I want to know my party went live without me | Round started, user not in room | Once per party |
| 9.3 | As a player, I want to know when a friend joins my party | Followed user joins a party I'm in | Max 1 per party per hour, batched |
| 9.4 | As a player, I want to know when a party in my lane is filling up | ≥60% full, <10 min to go | Max 1/day; only if no party of mine in the next hour |
| 9.5 | As a player, I want to know when I'm @mentioned | Mention in party chat or DM | Always, batched per thread |
| 9.6 | As a player, I want to know when a rival overtakes me | H2H lead flips, or a followed player passes me on the Climb Friends board | Max 1/day |
| 9.7 | As a player, I want a warning before my streak ends | 3h before midnight, daily not played, streak ≥ 2 | Once per day |
| 9.8 | As a player, I want to know how my Climb week ended | Week close, I played that week | Once per week; rank and people first, never the prize |
| 9.9 | As a winner or a brand, I want prize delivery prompts | Brand confirms; then day 3 and 7 if not delivered | To both sides |
| 9.10 | As a guest, I want a follow-up to keep my score | 24h after a guest game | Once |
| 9.11 | As a lapsed player, I want to hear what my people did | Day 3 and 7 with no session | Twice, then stop |
| 9.12 | As a brand, I want verification updates | Review approved or needs changes | Always |

**Rules.** Opt-in is asked at the first concrete moment, never on launch. Per-category toggles. Global cap of 3 pushes a day outside live-party events. Quiet hours 23:00–07:00 local except T-5 and live for parties I joined. Every push carries a reason and a deep link. No push leads with money. Send, open and dismiss are logged per nudge.

## 10. Rules every intent must respect

- **Lead with play, not money.** No screen or push leads with amounts paid out, pots or "win cash". Money appears only where it is a fact about a game in view. The app must read as a skill game.
- **Server is authoritative.** Round timing, scoring, prize settlement, seat allocation and flag thresholds are server-side. Correct answers and distributions never leave the server before a round closes.
- **Money is integer kobo in an append-only ledger** with idempotency keys; coins and cash are separate accounts; non-cash prizes are a fulfilment state machine, not a ledger entry.
- **AI disclosure.** Players are always told questions are AI-generated and whether the set was sealed or host-reviewed. Whoever has seen a set cannot play it.
- **Never fake presence.** "Online", "playing now" and "N in your round" must be true.
- **Guests** play and chat only; no saved score, no prizes, no coins; allowed only for free parties with no cash to be won.
- **Chat scope.** No general chat room. Party chat is open in the lobby, on standings and after; closed during question and reveal.
- **No blank Home.** Every state has a next move.
- **Nothing asked twice.** Anything collected in onboarding is editable from Me.

## 11. Open questions for architecture

- [ ] Host entity: `created_by_user` + nullable `brand` with a host-type flag, or a `hosts` table that is a user or a brand. Decide at party creation; write an ADR.
- [ ] Question generation thresholds: flag share and floor that voids a question; verification sources; first model/provider; bank-first vs generation-first at launch.
- [ ] Concurrency targets for load testing: parties in flight, players per party, rounds per second.
- [ ] Shared onboarding rounds: matchmaking window and minimum group size before falling back to solo.
- [x] Voice notes: decided (ADR 0007): 60 s cap and 1.5 MB (config), kept 90 days then deleted from storage (the line stays as expired), transcribed by the worker into the moderation queue. Transcription provider still to choose.
- [ ] Payout rail per platform and the Play Store policy boundary for cash withdrawal on Android.
- [x] Leaderboard scope beyond friends and everyone: crews done (row 6b, ADR 0008: Climb points plus party points from bragging-rights parties, weekly champion); interest communities later on the same scope key.
- [ ] Presence: what counts as "in the room" for live nudges and early-start decisions.
