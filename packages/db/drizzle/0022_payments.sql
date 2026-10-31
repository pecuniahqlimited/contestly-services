ALTER TYPE "public"."account_kind" ADD VALUE 'party_pot';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE 'bonus_issued';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE 'prize_funding';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE 'dev_mint';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE 'topup_in';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE 'payout_pending';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE 'payout_settled';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE 'payout_fees';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE 'platform_funds';--> statement-breakpoint
CREATE TABLE "admin_permissions" (
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"granted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_permissions_user_id_permission_pk" PRIMARY KEY("user_id","permission")
);
--> statement-breakpoint
CREATE TABLE "payment_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"severity" text NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_by_user_id" uuid,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payment_finalizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"provider_check" jsonb NOT NULL,
	"status" text NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"confirmed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payment_recon_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"object" text NOT NULL,
	"kind" text NOT NULL,
	"reference" text NOT NULL,
	"ours" jsonb,
	"theirs" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "payment_recon_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"day" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"counts" jsonb
);
--> statement-breakpoint
CREATE TABLE "payment_settings" (
	"version" serial PRIMARY KEY NOT NULL,
	"collections" text NOT NULL,
	"payouts" text NOT NULL,
	"topups_paused" boolean DEFAULT false NOT NULL,
	"payouts_paused" boolean DEFAULT false NOT NULL,
	"changed_by" text DEFAULT 'admin' NOT NULL,
	"created_by_user_id" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"reference" text,
	"body" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deliveries" integer DEFAULT 1 NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE "payout_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"bank_code" text NOT NULL,
	"bank_name" text NOT NULL,
	"account_number" text NOT NULL,
	"account_name" text NOT NULL,
	"recipient_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"payout_account_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"sent_kobo" bigint NOT NULL,
	"fee_kobo" bigint NOT NULL,
	"fee_bearer" text NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"provider" text NOT NULL,
	"reference" text NOT NULL,
	"status" text NOT NULL,
	"hold_reason" text,
	"send_attempts" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"checks" integer DEFAULT 0 NOT NULL,
	"next_check_at" timestamp with time zone,
	"last_check" jsonb,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"final_via" text,
	"final_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_amounts" CHECK ("payouts"."amount_kobo" > 0 and "payouts"."sent_kobo" > 0 and "payouts"."fee_kobo" >= 0 and "payouts"."sent_kobo" <= "payouts"."amount_kobo")
);
--> statement-breakpoint
CREATE TABLE "topups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"provider" text NOT NULL,
	"reference" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"checkout_url" text,
	"last_check" jsonb,
	"checks" integer DEFAULT 0 NOT NULL,
	"next_check_at" timestamp with time zone,
	"problem" jsonb,
	"credited_at" timestamp with time zone,
	"credited_via" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topups_amount_positive" CHECK ("topups"."amount_kobo" > 0)
);
--> statement-breakpoint
DROP INDEX "ledger_accounts_user_kind";--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "scope" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "journal_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_permissions" ADD CONSTRAINT "admin_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_permissions" ADD CONSTRAINT "admin_permissions_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_alerts" ADD CONSTRAINT "payment_alerts_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_finalizations" ADD CONSTRAINT "payment_finalizations_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_finalizations" ADD CONSTRAINT "payment_finalizations_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_recon_items" ADD CONSTRAINT "payment_recon_items_run_id_payment_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payment_recon_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_recon_items" ADD CONSTRAINT "payment_recon_items_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_payout_account_id_payout_accounts_id_fk" FOREIGN KEY ("payout_account_id") REFERENCES "public"."payout_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_alerts_dedupe" ON "payment_alerts" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "payment_alerts_open_idx" ON "payment_alerts" USING btree ("created_at") WHERE acknowledged_at is null;--> statement-breakpoint
CREATE INDEX "payment_finalizations_target_idx" ON "payment_finalizations" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_finalizations_one_open" ON "payment_finalizations" USING btree ("target_type","target_id") WHERE status = 'awaiting_second_admin';--> statement-breakpoint
CREATE INDEX "payment_recon_items_run_idx" ON "payment_recon_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "payment_recon_items_open_idx" ON "payment_recon_items" USING btree ("created_at") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "payment_recon_runs_day_idx" ON "payment_recon_runs" USING btree ("provider","day");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_events_provider_event" ON "payment_webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "payment_webhook_events_reference_idx" ON "payment_webhook_events" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_accounts_live" ON "payout_accounts" USING btree ("user_id","provider","bank_code","account_number") WHERE removed_at is null;--> statement-breakpoint
CREATE INDEX "payout_accounts_user_idx" ON "payout_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_provider_reference" ON "payouts" USING btree ("provider","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_reference" ON "payouts" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_user_request" ON "payouts" USING btree ("user_id","client_request_id");--> statement-breakpoint
CREATE INDEX "payouts_user_created_idx" ON "payouts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "payouts_status_due_idx" ON "payouts" USING btree ("status","next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "topups_provider_reference" ON "topups" USING btree ("provider","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "topups_reference" ON "topups" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "topups_user_created_idx" ON "topups" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "topups_due_idx" ON "topups" USING btree ("next_check_at") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_user_kind_scope" ON "ledger_accounts" USING btree ("user_id","kind","scope");--> statement-breakpoint
CREATE INDEX "ledger_entries_journal_idx" ON "ledger_entries" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_ref_idx" ON "ledger_entries" USING btree ("ref_type","ref_id");--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_person_not_negative" CHECK ("ledger_accounts"."kind" not in ('cash', 'bonus') or "ledger_accounts"."balance_kobo" >= 0);