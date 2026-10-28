CREATE TABLE "about_configs" (
	"audience" text NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "about_configs_audience_version_pk" PRIMARY KEY("audience","version")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "about_audience" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "about_version" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "about_answers" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "about_answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "archetype" text;--> statement-breakpoint
ALTER TABLE "about_configs" ADD CONSTRAINT "about_configs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;