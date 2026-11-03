CREATE TYPE "public"."corner_status" AS ENUM('locked', 'unlocked', 'revoked');--> statement-breakpoint
ALTER TYPE "public"."feed_kind" ADD VALUE 'corner_post';--> statement-breakpoint
CREATE TABLE "contact_matches" (
	"user_id" uuid NOT NULL,
	"contact_user_id" uuid NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_matches_user_id_contact_user_id_pk" PRIMARY KEY("user_id","contact_user_id")
);
--> statement-breakpoint
CREATE TABLE "corner_configs" (
	"version" integer PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corner_mutes" (
	"corner_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"muted_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corner_mutes_corner_id_user_id_pk" PRIMARY KEY("corner_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "corner_new_players" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"host_user_id" uuid NOT NULL,
	"via" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"party_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corner_parties" (
	"party_id" uuid PRIMARY KEY NOT NULL,
	"host_user_id" uuid NOT NULL,
	"real_players" integer NOT NULL,
	"counts" boolean NOT NULL,
	"finished_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corner_party_players" (
	"party_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"host_user_id" uuid NOT NULL,
	CONSTRAINT "corner_party_players_party_id_user_id_pk" PRIMARY KEY("party_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "corner_post_reactions" (
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corner_post_reactions_post_id_user_id_pk" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "corner_post_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"client_msg_id" uuid NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "corner_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corner_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "corners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"bio" text,
	"status" "corner_status" DEFAULT 'locked' NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"unlocked_at" timestamp with time zone,
	"unlock_config_version" integer,
	"unlock_contributors" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"revoked_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corners_owner_user_id_unique" UNIQUE("owner_user_id")
);
--> statement-breakpoint
CREATE TABLE "played_with" (
	"user_a" uuid NOT NULL,
	"user_b" uuid NOT NULL,
	"parties" integer DEFAULT 1 NOT NULL,
	"last_played_at" timestamp with time zone NOT NULL,
	CONSTRAINT "played_with_user_a_user_b_pk" PRIMARY KEY("user_a","user_b"),
	CONSTRAINT "played_with_ordered" CHECK ("played_with"."user_a" < "played_with"."user_b")
);
--> statement-breakpoint
CREATE TABLE "user_signals" (
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"user_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_signals_kind_value_user_id_pk" PRIMARY KEY("kind","value","user_id")
);
--> statement-breakpoint
ALTER TABLE "feed_events" ADD COLUMN "corner_post_id" uuid;--> statement-breakpoint
ALTER TABLE "contact_matches" ADD CONSTRAINT "contact_matches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_matches" ADD CONSTRAINT "contact_matches_contact_user_id_users_id_fk" FOREIGN KEY ("contact_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_configs" ADD CONSTRAINT "corner_configs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_mutes" ADD CONSTRAINT "corner_mutes_corner_id_corners_id_fk" FOREIGN KEY ("corner_id") REFERENCES "public"."corners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_mutes" ADD CONSTRAINT "corner_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_mutes" ADD CONSTRAINT "corner_mutes_muted_by_user_id_users_id_fk" FOREIGN KEY ("muted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_new_players" ADD CONSTRAINT "corner_new_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_new_players" ADD CONSTRAINT "corner_new_players_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_new_players" ADD CONSTRAINT "corner_new_players_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_parties" ADD CONSTRAINT "corner_parties_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_parties" ADD CONSTRAINT "corner_parties_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_party_players" ADD CONSTRAINT "corner_party_players_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_party_players" ADD CONSTRAINT "corner_party_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_party_players" ADD CONSTRAINT "corner_party_players_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_post_reactions" ADD CONSTRAINT "corner_post_reactions_post_id_corner_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."corner_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_post_reactions" ADD CONSTRAINT "corner_post_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_post_replies" ADD CONSTRAINT "corner_post_replies_post_id_corner_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."corner_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_post_replies" ADD CONSTRAINT "corner_post_replies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_post_replies" ADD CONSTRAINT "corner_post_replies_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_posts" ADD CONSTRAINT "corner_posts_corner_id_corners_id_fk" FOREIGN KEY ("corner_id") REFERENCES "public"."corners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_posts" ADD CONSTRAINT "corner_posts_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corner_posts" ADD CONSTRAINT "corner_posts_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corners" ADD CONSTRAINT "corners_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corners" ADD CONSTRAINT "corners_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "played_with" ADD CONSTRAINT "played_with_user_a_users_id_fk" FOREIGN KEY ("user_a") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "played_with" ADD CONSTRAINT "played_with_user_b_users_id_fk" FOREIGN KEY ("user_b") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_signals" ADD CONSTRAINT "user_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_matches_contact_idx" ON "contact_matches" USING btree ("contact_user_id");--> statement-breakpoint
CREATE INDEX "corner_new_players_host_idx" ON "corner_new_players" USING btree ("host_user_id","status");--> statement-breakpoint
CREATE INDEX "corner_parties_host_idx" ON "corner_parties" USING btree ("host_user_id","finished_at");--> statement-breakpoint
CREATE INDEX "corner_party_players_host_idx" ON "corner_party_players" USING btree ("host_user_id","user_id");--> statement-breakpoint
CREATE INDEX "corner_post_replies_post_idx" ON "corner_post_replies" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "corner_post_replies_client" ON "corner_post_replies" USING btree ("user_id","client_msg_id");--> statement-breakpoint
CREATE INDEX "corner_posts_corner_created_idx" ON "corner_posts" USING btree ("corner_id","created_at");--> statement-breakpoint
CREATE INDEX "corners_status_idx" ON "corners" USING btree ("status");--> statement-breakpoint
CREATE INDEX "played_with_b_idx" ON "played_with" USING btree ("user_b","last_played_at");--> statement-breakpoint
CREATE INDEX "user_signals_user_idx" ON "user_signals" USING btree ("user_id");--> statement-breakpoint
-- Follows point at corners (ADR 0012). Hand-written: a follow of someone who has a corner becomes a follow of
-- that corner; every other follow (and archived follow) is dropped. No corners exist when this runs, so on a
-- dev database all person follows go; there is no production data on this schema.
ALTER TABLE "follows" ADD COLUMN "corner_id" uuid;--> statement-breakpoint
UPDATE "follows" f SET "corner_id" = c."id" FROM "corners" c WHERE c."owner_user_id" = f."followee_id";--> statement-breakpoint
DELETE FROM "follows" WHERE "corner_id" IS NULL;--> statement-breakpoint
ALTER TABLE "follows" DROP CONSTRAINT "follows_follower_id_followee_id_pk";--> statement-breakpoint
ALTER TABLE "follows" DROP CONSTRAINT "follows_followee_id_users_id_fk";--> statement-breakpoint
DROP INDEX "follows_followee_idx";--> statement-breakpoint
ALTER TABLE "follows" DROP COLUMN "followee_id";--> statement-breakpoint
ALTER TABLE "follows" ALTER COLUMN "corner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_corner_id_pk" PRIMARY KEY("follower_id","corner_id");--> statement-breakpoint
ALTER TABLE "archived_follows" ADD COLUMN "corner_id" uuid;--> statement-breakpoint
UPDATE "archived_follows" f SET "corner_id" = c."id" FROM "corners" c WHERE c."owner_user_id" = f."followee_id";--> statement-breakpoint
DELETE FROM "archived_follows" WHERE "corner_id" IS NULL;--> statement-breakpoint
ALTER TABLE "archived_follows" DROP CONSTRAINT "archived_follows_followee_id_users_id_fk";--> statement-breakpoint
DROP INDEX "archived_follows_followee_idx";--> statement-breakpoint
ALTER TABLE "archived_follows" DROP COLUMN "followee_id";--> statement-breakpoint
ALTER TABLE "archived_follows" ALTER COLUMN "corner_id" SET NOT NULL;--> statement-breakpoint
-- played_with from every finished party so far: each pair of signed-up players, how often, and when last.
INSERT INTO "played_with" ("user_a", "user_b", "parties", "last_played_at")
SELECT a."user_id", b."user_id", count(*), max(coalesce(p."ended_at", p."starts_at"))
FROM "party_players" a JOIN "party_players" b ON b."party_id" = a."party_id" AND a."user_id" < b."user_id"
JOIN "parties" p ON p."id" = a."party_id" AND p."status" = 'finished'
JOIN "users" ua ON ua."id" = a."user_id" JOIN "users" ub ON ub."id" = b."user_id"
WHERE NOT ua."is_guest" AND NOT ub."is_guest"
GROUP BY a."user_id", b."user_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Version 1 of the unlock thresholds (DEFAULT_CORNER_UNLOCK): P 5, R 4, D 20, N 5.
INSERT INTO "corner_configs" ("version", "config") VALUES (1, '{"partiesHosted":5,"realPlayersPerParty":4,"distinctPlayers":20,"newPlayers":5}') ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "archived_follows" ADD CONSTRAINT "archived_follows_corner_id_corners_id_fk" FOREIGN KEY ("corner_id") REFERENCES "public"."corners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_events" ADD CONSTRAINT "feed_events_corner_post_id_corner_posts_id_fk" FOREIGN KEY ("corner_post_id") REFERENCES "public"."corner_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_corner_id_corners_id_fk" FOREIGN KEY ("corner_id") REFERENCES "public"."corners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archived_follows_corner_idx" ON "archived_follows" USING btree ("corner_id");--> statement-breakpoint
CREATE INDEX "feed_events_corner_post_idx" ON "feed_events" USING btree ("corner_post_id");--> statement-breakpoint
CREATE INDEX "follows_corner_created_idx" ON "follows" USING btree ("corner_id","created_at");
