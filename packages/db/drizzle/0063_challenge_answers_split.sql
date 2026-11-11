-- A challenge invitee's "expired" answer splits in two (ADR 0019, 11 Nov 2026): no_show, who accepted and wasn't in
-- the lobby when the window closed (dropNoShow freed their seat, so a party_leaves row has left_at = answered_at),
-- and no_answer, who never answered before the invite expired. Idempotent: a second run finds no "expired" rows.
UPDATE "party_challenge_invitees" i SET "answer" = 'no_show'
WHERE i."answer" = 'expired'
  AND EXISTS (SELECT 1 FROM "party_leaves" l WHERE l."party_id" = i."party_id" AND l."user_id" = i."user_id" AND l."left_at" = i."answered_at");--> statement-breakpoint
UPDATE "party_challenge_invitees" SET "answer" = 'no_answer' WHERE "answer" = 'expired';
