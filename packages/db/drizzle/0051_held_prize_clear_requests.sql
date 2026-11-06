ALTER TABLE "held_prizes" ADD COLUMN "clear_requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "held_prizes" ADD COLUMN "clear_request_reason" text;--> statement-breakpoint
ALTER TABLE "held_prizes" ADD COLUMN "clear_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "held_prizes" ADD CONSTRAINT "held_prizes_clear_requested_by_user_id_users_id_fk" FOREIGN KEY ("clear_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;