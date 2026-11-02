CREATE TABLE "owed_waivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"confirmed_by_user_id" uuid,
	"waived_kobo" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "owed_waivers" ADD CONSTRAINT "owed_waivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owed_waivers" ADD CONSTRAINT "owed_waivers_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owed_waivers" ADD CONSTRAINT "owed_waivers_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owed_waivers_one_open" ON "owed_waivers" USING btree ("user_id") WHERE status = 'awaiting_second_admin';