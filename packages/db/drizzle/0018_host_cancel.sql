ALTER TABLE "parties" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "cancelled_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;