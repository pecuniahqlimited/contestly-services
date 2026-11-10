ALTER TABLE "brands" ADD COLUMN "pending_logo_key" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "pending_logo_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "pending_logo_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "logo_rejected_note" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "logo_rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_pending_logo_by_user_id_users_id_fk" FOREIGN KEY ("pending_logo_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brands_pending_logo_idx" ON "brands" USING btree ("pending_logo_at") WHERE pending_logo_key is not null;