CREATE TABLE "ai_routing_configs" (
	"version" integer PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "profile" text;--> statement-breakpoint
ALTER TABLE "question_generations" ADD COLUMN "route" jsonb;--> statement-breakpoint
ALTER TABLE "ai_routing_configs" ADD CONSTRAINT "ai_routing_configs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;