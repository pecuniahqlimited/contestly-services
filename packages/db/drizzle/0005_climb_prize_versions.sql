CREATE TABLE "climb_prize_configs" (
	"version" serial PRIMARY KEY NOT NULL,
	"winners" integer NOT NULL,
	"prize_kobo" integer[] NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "climb_week_prizes" (
	"week" text PRIMARY KEY NOT NULL,
	"prize_version" integer NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "climb_prize_configs" ADD CONSTRAINT "climb_prize_configs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_week_prizes" ADD CONSTRAINT "climb_week_prizes_prize_version_climb_prize_configs_version_fk" FOREIGN KEY ("prize_version") REFERENCES "public"."climb_prize_configs"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Weekly prizes moved out of the "climb" settings into climb_prize_configs.
UPDATE "app_config" SET "value" = "value" - 'weeklyWinners' - 'weeklyPrizeKobo' WHERE "key" = 'climb';