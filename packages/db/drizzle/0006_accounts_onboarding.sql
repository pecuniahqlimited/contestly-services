CREATE TABLE "email_configs" (
	"version" serial PRIMARY KEY NOT NULL,
	"primary" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template" text NOT NULL,
	"to" text NOT NULL,
	"delivered_by" text,
	"attempts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_devices" (
	"device_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_rounds" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"players" integer NOT NULL,
	"points" integer NOT NULL,
	"correct" integer NOT NULL,
	"questions" integer NOT NULL,
	"rank" integer NOT NULL,
	"coins_kobo" integer NOT NULL,
	"device_hash" text,
	"bank_question_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_outcome" text
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_provider_external_id_pk" PRIMARY KEY("provider","external_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_hmac" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "who" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "why" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invite_party_id" uuid;--> statement-breakpoint
ALTER TABLE "email_configs" ADD CONSTRAINT "email_configs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_devices" ADD CONSTRAINT "onboarding_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_rounds" ADD CONSTRAINT "onboarding_rounds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_sends_created_idx" ON "email_sends" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invite_party_id_parties_id_fk" FOREIGN KEY ("invite_party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_hmac_unique" UNIQUE("phone_hmac");