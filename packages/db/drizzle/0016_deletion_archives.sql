ALTER TYPE "public"."climb_award_status" ADD VALUE 'void';--> statement-breakpoint
CREATE TABLE "archived_crew_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crew_id" uuid NOT NULL,
	"invitee_id" uuid NOT NULL,
	"inviter_id" uuid NOT NULL,
	"status" "invite_status" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archived_follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"follower_id" uuid NOT NULL,
	"followee_id" uuid NOT NULL,
	"notify" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archived_crew_invites" ADD CONSTRAINT "archived_crew_invites_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archived_crew_invites" ADD CONSTRAINT "archived_crew_invites_invitee_id_users_id_fk" FOREIGN KEY ("invitee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archived_crew_invites" ADD CONSTRAINT "archived_crew_invites_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archived_follows" ADD CONSTRAINT "archived_follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archived_follows" ADD CONSTRAINT "archived_follows_followee_id_users_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archived_crew_invites_invitee_idx" ON "archived_crew_invites" USING btree ("invitee_id");--> statement-breakpoint
CREATE INDEX "archived_crew_invites_inviter_idx" ON "archived_crew_invites" USING btree ("inviter_id");--> statement-breakpoint
CREATE INDEX "archived_follows_follower_idx" ON "archived_follows" USING btree ("follower_id");--> statement-breakpoint
CREATE INDEX "archived_follows_followee_idx" ON "archived_follows" USING btree ("followee_id");