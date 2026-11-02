ALTER TYPE "public"."account_kind" ADD VALUE 'entry_forfeited';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE 'fee_variance';--> statement-breakpoint
CREATE TABLE "entry_forfeits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"banned_at" timestamp with time zone NOT NULL,
	"ban_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invariant_acknowledgments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"items" jsonb NOT NULL,
	"detail" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"confirmed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "entry_forfeits" ADD CONSTRAINT "entry_forfeits_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_forfeits" ADD CONSTRAINT "entry_forfeits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invariant_acknowledgments" ADD CONSTRAINT "invariant_acknowledgments_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invariant_acknowledgments" ADD CONSTRAINT "invariant_acknowledgments_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entry_forfeits_seat" ON "entry_forfeits" USING btree ("seat_id");--> statement-breakpoint
CREATE INDEX "invariant_acknowledgments_kind_idx" ON "invariant_acknowledgments" USING btree ("kind");