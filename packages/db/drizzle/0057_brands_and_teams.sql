CREATE TYPE "public"."brand_role" AS ENUM('owner', 'admin', 'host', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."brand_verification_status" AS ENUM('draft', 'in_review', 'changes_needed', 'verified');--> statement-breakpoint
CREATE TABLE "brand_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" uuid,
	"subject_user_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"invitee_user_id" uuid,
	"email" text,
	"role" "brand_role" NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "brand_invites_to_someone" CHECK ("brand_invites"."invitee_user_id" is not null or "brand_invites"."email" is not null),
	CONSTRAINT "brand_invites_not_owner" CHECK ("brand_invites"."role" <> 'owner')
);
--> statement-breakpoint
CREATE TABLE "brand_members" (
	"brand_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "brand_role" NOT NULL,
	"invited_by_user_id" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_members_brand_id_user_id_pk" PRIMARY KEY("brand_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"logo_url" text,
	"lane" text,
	"site_url" text,
	"socials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"registration_number" text,
	"business_email" text,
	"business_email_verified_at" timestamp with time zone,
	"cash_prizes" boolean DEFAULT false NOT NULL,
	"verification_status" "brand_verification_status" DEFAULT 'draft' NOT NULL,
	"verification_note" text,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prize_fulfilment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fulfilment_id" uuid NOT NULL,
	"from_status" "fulfilment_status" NOT NULL,
	"to_status" "fulfilment_status" NOT NULL,
	"by_user_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "sent_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "prize_fulfilments" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "prize_fulfilments" ADD COLUMN "dispute_note" text;--> statement-breakpoint
ALTER TABLE "prize_fulfilments" ADD COLUMN "arranged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prize_fulfilments" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prize_fulfilments" ADD COLUMN "disputed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prize_fulfilments" ADD COLUMN "nudged_days" integer[] DEFAULT '{}'::int[] NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_events" ADD CONSTRAINT "brand_events_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_events" ADD CONSTRAINT "brand_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_events" ADD CONSTRAINT "brand_events_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_invites" ADD CONSTRAINT "brand_invites_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_invites" ADD CONSTRAINT "brand_invites_invitee_user_id_users_id_fk" FOREIGN KEY ("invitee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_invites" ADD CONSTRAINT "brand_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_members" ADD CONSTRAINT "brand_members_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_members" ADD CONSTRAINT "brand_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_members" ADD CONSTRAINT "brand_members_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_fulfilment_events" ADD CONSTRAINT "prize_fulfilment_events_fulfilment_id_prize_fulfilments_id_fk" FOREIGN KEY ("fulfilment_id") REFERENCES "public"."prize_fulfilments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_fulfilment_events" ADD CONSTRAINT "prize_fulfilment_events_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_events_brand_idx" ON "brand_events" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_invites_open_user" ON "brand_invites" USING btree ("brand_id","invitee_user_id") WHERE status = 'pending' and invitee_user_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_invites_open_email" ON "brand_invites" USING btree ("brand_id","email") WHERE status = 'pending' and invitee_user_id is null;--> statement-breakpoint
CREATE INDEX "brand_invites_invitee_idx" ON "brand_invites" USING btree ("invitee_user_id","status");--> statement-breakpoint
CREATE INDEX "brand_invites_email_idx" ON "brand_invites" USING btree ("email","status");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_members_one_owner" ON "brand_members" USING btree ("brand_id") WHERE role = 'owner';--> statement-breakpoint
CREATE INDEX "brand_members_user_idx" ON "brand_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "brands_status_idx" ON "brands" USING btree ("verification_status","submitted_at");--> statement-breakpoint
CREATE INDEX "prize_fulfilment_events_fulfilment_idx" ON "prize_fulfilment_events" USING btree ("fulfilment_id","created_at");--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parties_brand_idx" ON "parties" USING btree ("brand_id","starts_at");--> statement-breakpoint
CREATE INDEX "prize_fulfilments_host_idx" ON "prize_fulfilments" USING btree ("host_user_id","status");--> statement-breakpoint
CREATE INDEX "prize_fulfilments_winner_idx" ON "prize_fulfilments" USING btree ("winner_user_id");--> statement-breakpoint
-- ADR 0017: accounts made as brands before row 8 (seed data: users.is_brand) get their brands row, verified if the
-- account was, and lose any email: a brand's account is never signed into. Their parties name them as the brand.
INSERT INTO "brands" ("id", "created_by_user_id", "verification_status", "decided_at")
  SELECT "id", "id", CASE WHEN "is_verified" THEN 'verified'::"brand_verification_status" ELSE 'draft'::"brand_verification_status" END, CASE WHEN "is_verified" THEN now() END
  FROM "users" WHERE "is_brand" ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "users" SET "email" = NULL, "email_verified_at" = NULL WHERE "is_brand";--> statement-breakpoint
UPDATE "parties" SET "brand_id" = "created_by_user_id" WHERE "brand_id" IS NULL AND "created_by_user_id" IN (SELECT "id" FROM "brands");
