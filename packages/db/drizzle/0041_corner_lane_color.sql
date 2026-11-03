ALTER TABLE "corners" ADD COLUMN "lane" text;--> statement-breakpoint
ALTER TABLE "corners" ADD COLUMN "lane_chosen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "corners" ADD COLUMN "color" text DEFAULT '#0B64FC' NOT NULL;--> statement-breakpoint
-- Each existing corner's default lane: the lane most of its host's finished parties were tagged with, ties to
-- the most recent (mostlyAbout in shared); categories that aren't lanes don't count.
UPDATE "corners" c SET "lane" = d.category FROM (
  SELECT DISTINCT ON (cp.host_user_id) cp.host_user_id, p.category
  FROM "corner_parties" cp JOIN "parties" p ON p.id = cp.party_id
  WHERE p.category IN ('Afrobeats', 'Football', 'Nollywood', 'General knowledge', 'History', 'Science', 'Tech', 'Fashion', 'Food', 'Geography', 'Brain teasers', 'Reality TV', 'Maths', 'Hip hop')
  GROUP BY cp.host_user_id, p.category
  ORDER BY cp.host_user_id, count(*) DESC, max(cp.finished_at) DESC
) d WHERE d.host_user_id = c.owner_user_id;
