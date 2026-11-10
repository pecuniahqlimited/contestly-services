CREATE TABLE "party_challenge_invitees" (
	"party_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"answer" text DEFAULT 'pending' NOT NULL,
	"answered_at" timestamp with time zone,
	"thread_id" uuid NOT NULL,
	CONSTRAINT "party_challenge_invitees_party_id_user_id_pk" PRIMARY KEY("party_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "party_challenges" (
	"party_id" uuid PRIMARY KEY NOT NULL,
	"challenger_user_id" uuid NOT NULL,
	"message" text,
	"invite_expires_at" timestamp with time zone NOT NULL,
	"join_window_minutes" integer NOT NULL,
	"window_opens_at" timestamp with time zone,
	"window_closes_at" timestamp with time zone,
	"ending" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "party_challenge_invitees" ADD CONSTRAINT "party_challenge_invitees_party_id_party_challenges_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."party_challenges"("party_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_challenge_invitees" ADD CONSTRAINT "party_challenge_invitees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_challenge_invitees" ADD CONSTRAINT "party_challenge_invitees_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_challenges" ADD CONSTRAINT "party_challenges_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_challenges" ADD CONSTRAINT "party_challenges_challenger_user_id_users_id_fk" FOREIGN KEY ("challenger_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "party_challenge_invitees_user_idx" ON "party_challenge_invitees" USING btree ("user_id","answer");