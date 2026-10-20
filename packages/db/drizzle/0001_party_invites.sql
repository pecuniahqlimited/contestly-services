CREATE TYPE "public"."invite_status" AS ENUM('pending', 'accepted', 'dismissed');--> statement-breakpoint
CREATE TABLE "party_invites" (
	"party_id" uuid NOT NULL,
	"invitee_id" uuid NOT NULL,
	"inviter_id" uuid NOT NULL,
	"status" "invite_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "party_invites_party_id_invitee_id_pk" PRIMARY KEY("party_id","invitee_id")
);
--> statement-breakpoint
ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_invitee_id_users_id_fk" FOREIGN KEY ("invitee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "party_invites_invitee_idx" ON "party_invites" USING btree ("invitee_id","status");--> statement-breakpoint
CREATE INDEX "party_players_user_idx" ON "party_players" USING btree ("user_id");