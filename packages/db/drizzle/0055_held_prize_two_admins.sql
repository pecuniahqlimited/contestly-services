ALTER TABLE "held_prizes" RENAME COLUMN "clear_requested_by_user_id" TO "requested_by_user_id";--> statement-breakpoint
ALTER TABLE "held_prizes" RENAME COLUMN "clear_request_reason" TO "request_reason";--> statement-breakpoint
ALTER TABLE "held_prizes" RENAME COLUMN "clear_requested_at" TO "requested_at";--> statement-breakpoint
ALTER TABLE "held_prizes" DROP CONSTRAINT "held_prizes_clear_requested_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "held_prizes" ADD COLUMN "requested_decision" text;--> statement-breakpoint
ALTER TABLE "held_prizes" ADD CONSTRAINT "held_prizes_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_prizes" ADD CONSTRAINT "held_prizes_decision_known" CHECK ("held_prizes"."requested_decision" in ('clear', 'reject'));--> statement-breakpoint
-- A clear request from before every decision took two admins is a request to clear.
UPDATE "held_prizes" SET "requested_decision" = 'clear' WHERE "requested_by_user_id" IS NOT NULL;
