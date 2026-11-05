# ADR 0015: Party templates and host-authored questions

Status: accepted (5 Nov 2026). Roadmap row 13, brought forward to launch (20 Nov) for personal templates. Amends ADR 0003 (curate drafts).

## Context

Hosts throw parties for occasions: a birthday, a bridal shower, an office party. The best questions for those are about the people in the room ("Where did Tolu and Femi first meet?"), which no engine can generate or check. Today every question comes from the engine and is fact-verified. Templates let a host start from an occasion instead of a blank brief, and add questions only they can write.

## Decision

1. **Templates are data, managed entirely from the admin console.** Nothing about any template is hard-coded: admins **add, edit, reorder, hide and remove** templates without a release, with a preview, every change logged with a reason and versioned like About you. Each template has a name, a one-line pitch, an occasion, a cover, default dials (difficulty, seconds per question, count, formats), a list of **host prompts** and a **themed-question spec** for the engine. The starting set is seed data, not code. A party made from a template keeps its own copy, so editing or removing a template never changes a party already created from it.
2. **At launch: six personal templates.** Birthday, bridal shower, couples' hangout, game night, office party, reunion. Brand templates (product knowledge, product launch, the feedback poll format) follow row 8, after launch.
3. **Picking a template prefills the builder.** In the builder's first scene a host picks a template instead of typing a brief. It prefills the name, brief, cover, dials and a starter set. The host can edit or delete any of it, down to an empty set, and add their own questions to any party, template or not.
4. **Two kinds of question in a set:**
   - **Host-authored:** the host writes the question and the correct answer. The engine suggests three distractors of the same type and length (the host can edit them). Pick-one only at launch. They **skip fact verification** (nothing can check them) but **never the safety filter**, which fails closed. They're marked host-authored, stored with the party only, and **never enter the shared bank**.
   - **Themed:** generated or retrieved from the template's spec through the normal pipeline, with every check.
5. **Any set with a host-authored question runs in curate mode** (ADR 0003): the host reviews the whole set, and the host, the host's team and anyone who saw the drafts can't play. The lobby and game screen say the set includes host-written questions.
6. **Stakes.** Template parties are host-funded or entry-fee (pooled) only, never free (decided Oct 2026).
7. **Anti-collusion, because the host knows every answer.** A friend of the host could be told the answers, so for any party with host-authored questions and money at stake:
   - **Caps** (config): a maximum entry fee and a maximum host-funded cash prize, and host-authored questions can make up at most a set share of the questions (default 50%), so the themed questions still decide most of the game.
   - **A link check at settlement:** a winner is "linked" to the host if they're in the host's people (crew mate, contact, played with recently) or share an install id or IP with the host.
   - **An outlier check:** a linked winner whose host-authored accuracy is far above the room's (config threshold) is flagged.
   - **A flagged prize is held, not paid out:** it's credited but can't be withdrawn until an admin clears it (one admin, with a reason, logged), and a warning alert is raised. A rejected prize goes back into the pot for the next placed player or is refunded, by the rules in the implementation.
   - Free play between friends isn't affected; these rules only apply where money moves.
8. **Host-funded cash prizes** to a linked winner go through the same check, since a host funding a friend's withdrawable win is a way to move money.
9. **Learning:** host-authored questions are excluded from difficulty calibration and the bank's play stats, since they only ever run once.

## Consequences

- The builder gains a template picker and a host-prompt editor (question, correct answer, suggested distractors).
- The questions service gains a distractor-suggestion call (a generation call, then the safety filter) and a template-spec input to set generation.
- Settlement gains the link and outlier checks and a prize-hold state for flagged prizes, using the payments hold machinery rather than a new path.
- Admins get template config with preview, and a queue for held template prizes.

## Not decided here

- Brand templates and the feedback poll format (after row 8).
- Formats beyond pick-one for host-authored questions.
- Whether free template parties should be allowed later (today: never).
