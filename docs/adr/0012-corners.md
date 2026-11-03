# ADR 0012: People follow corners, not each other

Status: accepted (3 Nov 2026). Roadmap row 6c. Supersedes the person-follow parts of ADR 0008.

## Context

The reason people come to Contestly is the hosts who run good parties. Following other players adds a social graph that mostly duplicates crews, contacts and "played together", and it spreads people's attention thin. The current Lovable app already has host Corners (the Hall), and its hosts have followers we want to keep.

## Decision

1. **A corner is a host's home, one per account.** It holds Up next, Winners, a weekly Regulars board and host posts. Anyone can host a party without a corner.
2. **Corners are earned.** Unlocking needs all four thresholds from versioned admin config, counted over all time:
   - **P = 5** finished parties hosted;
   - **R = 4** real players in a party for it to count (signed in, actually played, host excluded);
   - **D = 20** distinct real players across the counted parties;
   - **N = 5** new players brought.

   A new player is someone whose first finished party on Contestly was hosted by this host, or who signed up from this host's invite. N measures how many new people a host brings to the app, so a host can't unlock by running the same four friends through five parties. Unlocking is automatic the moment all four are met.
3. **Anti-farming for N, without making anyone wait.** A new player counts for a host as soon as they finish that host's party, if they signed up with a **verified email** and their **device hasn't been seen on another account** (a soft signal on the web build, not proof). Each new player counts for one host only, the first. There is no requirement to play elsewhere first, so unlocking is never delayed. Instead:
   - every unlock records which players made up N, and raises an info alert so admins can spot-check it;
   - an unlock where several of the N players share an IP or device cluster with each other or with the host raises a warning instead;
   - an admin can revoke a farmed corner (logged, with a reason); banning the new-player accounts removes them from N.
4. **Verified brands get a corner on approval** (row 8), with no unlock.
5. **Follows point at corners.** The follows table becomes corner follows, and per-follow alerts become per-corner alerts (on by default). Follower counts live on corners. Profiles have no follow button.
6. **A corner's follower list is public.** Anyone viewing a corner can see its count and its list of followers, with "N of your people follow this corner" on top; seeing who's there is a reason to join. Each person can see their own follows. (A per-person setting to leave themselves off follower lists can come later if people ask for it.)
7. **Social ties between people come from play and contacts**, not follows. *Your people* are crew mates, matched contacts, and people you've finished a party with in the last **30 days** (config). Your people replace "people you follow" on the friends board, in mutuals, in nudges 9.3 and 9.6, and in the lobby's "who's in".
8. **DMs.** `dmPermission()` drops "the recipient follows you" and adds "you're contacts". Shared crew and "finished a party together" stay. Everyone else gets a message request. The brand rule is unchanged.
9. **Host posts are text only in v1.** No images, voice or video, to keep storage and moderation small. Followers can react with a fixed set of emoji and reply one level deep. Replies go through the chat pipeline (profanity mask, rate limit, report). The host can delete a reply or mute a follower in their corner. This is the only thread outside party, DM and crew chat; it is tied to a post, so it doesn't break the "no general chat room" rule.
10. **Parties tab.** Public parties from hosts without a corner still show. Until the recommendation service (row 7) defines ranking, the tab sorts by starting soonest, with parties filling up first.
11. **Levels.** Unlocking gives level 1. Levels after unlock (thresholds and perks) are admin config, built over time; none ship with perks at launch. Perks will never be money perks.
12. **Corners are not taken away for inactivity.** A corner that goes quiet drops out of recommendations. A ban removes it, and so can an admin revoking a farmed unlock.
13. **Migration (row 11b).** The current app's corners (Contestly_HQ, Prince, Chika, August, Sammie) are created already unlocked, with their followers carried over as corner follows.

## Consequences

- 6b's follow work is repointed, not thrown away: the follows table, alerts, feed and mutuals change their target. The friends board and `dmPermission()` change their inputs. The app's follow buttons on profiles and in the lobby become "Follow corner", shown only when the host has one.
- "Played with" becomes a first-class relationship. It needs a read model (pairs who finished a party together, with the last date) that the boards, DMs and nudges share.
- Unlock progress (P, R, D, N with who counted) needs its own read model, updated as parties finish, so a host can see how close they are.
- The feed gains a new item type (host posts) with replies, reactions and moderation.
- Public follower lists mean following a corner is visible to others; the app should say so where you follow.

## Not decided here

- Level thresholds and perks (admin config, later).
- Parties tab ranking (row 7).
- Whether people can hide themselves from follower lists (later, if asked for).
