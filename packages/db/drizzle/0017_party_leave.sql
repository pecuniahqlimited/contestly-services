CREATE TABLE "party_leaves" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"party_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"refunded_bonus_kobo" integer NOT NULL,
	"refunded_cash_kobo" integer NOT NULL,
	"left_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "party_players" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "party_players" ADD COLUMN "entry_key" text;--> statement-breakpoint
ALTER TABLE "party_leaves" ADD CONSTRAINT "party_leaves_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_leaves" ADD CONSTRAINT "party_leaves_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "party_leaves_party_user_idx" ON "party_leaves" USING btree ("party_id","user_id","left_at");--> statement-breakpoint
ALTER TABLE "party_players" ADD CONSTRAINT "party_players_id_unique" UNIQUE("id");