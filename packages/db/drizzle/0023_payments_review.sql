ALTER TYPE "public"."account_kind" ADD VALUE 'payout_owed';--> statement-breakpoint
CREATE TABLE "payment_config_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"before" jsonb NOT NULL,
	"proposed" jsonb NOT NULL,
	"loosens" text[] NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"confirmed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payout_contradictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"provider_check" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by_user_id" uuid,
	"request_reason" text,
	"requested_at" timestamp with time zone,
	"confirmed_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"recovered_kobo" bigint,
	"owed_kobo" bigint
);
--> statement-breakpoint
ALTER TABLE "payment_finalizations" ADD COLUMN "amount_kobo" bigint;--> statement-breakpoint
ALTER TABLE "payment_finalizations" ADD COLUMN "second_admin_because" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "topups" ADD COLUMN "credited_kobo" bigint;--> statement-breakpoint
ALTER TABLE "topups" ADD COLUMN "attempt_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "withdrawals_frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_config_changes" ADD CONSTRAINT "payment_config_changes_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_config_changes" ADD CONSTRAINT "payment_config_changes_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_contradictions" ADD CONSTRAINT "payout_contradictions_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_contradictions" ADD CONSTRAINT "payout_contradictions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_contradictions" ADD CONSTRAINT "payout_contradictions_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_contradictions" ADD CONSTRAINT "payout_contradictions_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_config_changes_one_open" ON "payment_config_changes" USING btree ("kind") WHERE status = 'awaiting_second_admin';--> statement-breakpoint
CREATE UNIQUE INDEX "payout_contradictions_payout" ON "payout_contradictions" USING btree ("payout_id");--> statement-breakpoint
CREATE INDEX "payout_contradictions_user_idx" ON "payout_contradictions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payment_webhook_events_retry_idx" ON "payment_webhook_events" USING btree ("next_attempt_at") WHERE processed_at is null;--> statement-breakpoint
UPDATE "topups" SET "credited_kobo" = "amount_kobo" WHERE "status" = 'succeeded';
