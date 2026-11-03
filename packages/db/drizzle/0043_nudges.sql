CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"install_id" text NOT NULL,
	"platform" text NOT NULL,
	"token" text,
	"app_version" text NOT NULL,
	"permission" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "nudges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"data" jsonb NOT NULL,
	"actors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"deep_link" text NOT NULL,
	"reason" text NOT NULL,
	"dedupe_key" text,
	"batch_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"channel" text,
	"skip_reason" text,
	"pushes" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "time_zone" text DEFAULT 'Africa/Lagos' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "nudges_off" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_tokens_user_install" ON "device_tokens" USING btree ("user_id","install_id");--> statement-breakpoint
CREATE INDEX "nudges_due_idx" ON "nudges" USING btree ("due_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "nudges_user_decided_idx" ON "nudges" USING btree ("user_id","decided_at");--> statement-breakpoint
CREATE INDEX "nudges_ref_idx" ON "nudges" USING btree ("ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nudges_user_dedupe" ON "nudges" USING btree ("user_id","dedupe_key") WHERE dedupe_key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "nudges_user_batch_pending" ON "nudges" USING btree ("user_id","batch_key") WHERE batch_key is not null and status = 'pending';