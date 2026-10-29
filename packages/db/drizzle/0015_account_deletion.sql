ALTER TABLE "user_identities" DROP CONSTRAINT "user_identities_provider_external_id_pk";--> statement-breakpoint
ALTER TABLE "user_identities" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_identities" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "archived_email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "archived_handle" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "archived_display_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "archived_avatar_emoji" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "archived_bio" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "archived_phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "archived_phone_hmac" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "archive_cleared_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_live_key" ON "user_identities" USING btree ("provider","external_id") WHERE disabled_at is null;--> statement-breakpoint
CREATE INDEX "users_archived_email_idx" ON "users" USING btree ("archived_email");--> statement-breakpoint
CREATE INDEX "users_archived_handle_idx" ON "users" USING btree ("archived_handle");