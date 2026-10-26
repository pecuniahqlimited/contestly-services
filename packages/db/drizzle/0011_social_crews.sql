CREATE TYPE "public"."crew_role" AS ENUM('creator', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."feed_kind" AS ENUM('party_finished', 'climb_best', 'streak');--> statement-breakpoint
CREATE TABLE "crew_invites" (
	"crew_id" uuid NOT NULL,
	"invitee_id" uuid NOT NULL,
	"inviter_id" uuid NOT NULL,
	"status" "invite_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "crew_invites_crew_id_invitee_id_pk" PRIMARY KEY("crew_id","invitee_id")
);
--> statement-breakpoint
CREATE TABLE "crew_members" (
	"crew_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "crew_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_members_crew_id_user_id_pk" PRIMARY KEY("crew_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "crews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"emoji" text NOT NULL,
	"color" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "feed_kind" NOT NULL,
	"data" jsonb NOT NULL,
	"party_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_days" (
	"user_id" uuid NOT NULL,
	"day" text NOT NULL,
	"week" text NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"parties" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "party_days_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "crew_id" uuid;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "rematch_of" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "best_streak_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crew_invites" ADD CONSTRAINT "crew_invites_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_invites" ADD CONSTRAINT "crew_invites_invitee_id_users_id_fk" FOREIGN KEY ("invitee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_invites" ADD CONSTRAINT "crew_invites_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crews" ADD CONSTRAINT "crews_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_events" ADD CONSTRAINT "feed_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_events" ADD CONSTRAINT "feed_events_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_days" ADD CONSTRAINT "party_days_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crew_invites_invitee_idx" ON "crew_invites" USING btree ("invitee_id","status");--> statement-breakpoint
CREATE INDEX "crew_members_user_idx" ON "crew_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crew_members_one_creator" ON "crew_members" USING btree ("crew_id") WHERE role = 'creator';--> statement-breakpoint
CREATE INDEX "feed_events_user_created_idx" ON "feed_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_events_party_once" ON "feed_events" USING btree ("user_id","party_id") WHERE kind = 'party_finished';--> statement-breakpoint
CREATE INDEX "party_days_week_idx" ON "party_days" USING btree ("week");--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_rematch_of_parties_id_fk" FOREIGN KEY ("rematch_of") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_rematch_of_unique" UNIQUE("rematch_of");--> statement-breakpoint
-- Hand-written: the best streak so far is at least the current one.
UPDATE "users" SET "best_streak_days" = "streak_days";
