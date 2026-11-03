ALTER TABLE "corners" ADD COLUMN "granted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "corners" ADD COLUMN "granted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "corners" ADD COLUMN "granted_reason" text;--> statement-breakpoint
ALTER TABLE "corners" ADD CONSTRAINT "corners_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;