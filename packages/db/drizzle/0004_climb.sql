CREATE TYPE "public"."climb_award_status" AS ENUM('pending', 'approved', 'paid', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."climb_run_status" AS ENUM('active', 'cleared', 'missed', 'abandoned');--> statement-breakpoint
CREATE TABLE "climb_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"place" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"points" integer NOT NULL,
	"amount_kobo" integer NOT NULL,
	"status" "climb_award_status" DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "climb_challenge_answers" (
	"attempt_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"answer" integer,
	"answered_at" timestamp with time zone,
	"correct" boolean,
	CONSTRAINT "climb_challenge_answers_attempt_id_idx_pk" PRIMARY KEY("attempt_id","idx")
);
--> statement-breakpoint
CREATE TABLE "climb_challenge_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"option_order" jsonb NOT NULL,
	"correct" integer DEFAULT 0 NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "climb_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" text NOT NULL,
	"title" text NOT NULL,
	"questions" jsonb NOT NULL,
	"seconds" integer NOT NULL,
	"max_points" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "climb_challenges_day_unique" UNIQUE("day")
);
--> statement-breakpoint
CREATE TABLE "climb_days" (
	"user_id" uuid NOT NULL,
	"day" text NOT NULL,
	"week" text NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"best_run_points" integer DEFAULT 0 NOT NULL,
	"best_run_stages" integer DEFAULT 0 NOT NULL,
	"best_run_id" uuid,
	"challenge_points" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "climb_days_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "climb_ladders" (
	"version" serial PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "climb_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"stage_idx" integer NOT NULL,
	"game_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"answer" jsonb,
	"answered_at" timestamp with time zone,
	"correct" boolean
);
--> statement-breakpoint
CREATE TABLE "climb_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ladder_version" integer NOT NULL,
	"status" "climb_run_status" DEFAULT 'active' NOT NULL,
	"stage_idx" integer DEFAULT 0 NOT NULL,
	"stages_cleared" integer DEFAULT 0 NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"day" text NOT NULL,
	"stage_ms" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "climb_week_results" (
	"week" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"user_id" uuid NOT NULL,
	"place" integer NOT NULL,
	"points" integer NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "climb_week_results_week_scope_scope_id_user_id_pk" PRIMARY KEY("week","scope","scope_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "climb_weeks" (
	"user_id" uuid NOT NULL,
	"week" text NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"best_run_stages" integer DEFAULT 0 NOT NULL,
	"cleared_all" boolean DEFAULT false NOT NULL,
	"reached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "climb_weeks_user_id_week_pk" PRIMARY KEY("user_id","week")
);
--> statement-breakpoint
ALTER TABLE "climb_awards" ADD CONSTRAINT "climb_awards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_awards" ADD CONSTRAINT "climb_awards_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_challenge_answers" ADD CONSTRAINT "climb_challenge_answers_attempt_id_climb_challenge_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."climb_challenge_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_challenge_attempts" ADD CONSTRAINT "climb_challenge_attempts_challenge_id_climb_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."climb_challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_challenge_attempts" ADD CONSTRAINT "climb_challenge_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_challenges" ADD CONSTRAINT "climb_challenges_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_days" ADD CONSTRAINT "climb_days_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_days" ADD CONSTRAINT "climb_days_best_run_id_climb_runs_id_fk" FOREIGN KEY ("best_run_id") REFERENCES "public"."climb_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_ladders" ADD CONSTRAINT "climb_ladders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_rounds" ADD CONSTRAINT "climb_rounds_run_id_climb_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."climb_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_runs" ADD CONSTRAINT "climb_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_runs" ADD CONSTRAINT "climb_runs_ladder_version_climb_ladders_version_fk" FOREIGN KEY ("ladder_version") REFERENCES "public"."climb_ladders"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_week_results" ADD CONSTRAINT "climb_week_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "climb_weeks" ADD CONSTRAINT "climb_weeks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "climb_awards_place" ON "climb_awards" USING btree ("week","scope","scope_id","place");--> statement-breakpoint
CREATE INDEX "climb_awards_status_idx" ON "climb_awards" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "climb_attempts_one_per_user" ON "climb_challenge_attempts" USING btree ("challenge_id","user_id");--> statement-breakpoint
CREATE INDEX "climb_days_week_idx" ON "climb_days" USING btree ("week");--> statement-breakpoint
CREATE UNIQUE INDEX "climb_rounds_run_seq" ON "climb_rounds" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "climb_runs_user_day_idx" ON "climb_runs" USING btree ("user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "climb_runs_one_active" ON "climb_runs" USING btree ("user_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "climb_week_results_place" ON "climb_week_results" USING btree ("week","scope","scope_id","place");--> statement-breakpoint
CREATE INDEX "climb_weeks_week_points_idx" ON "climb_weeks" USING btree ("week","points");--> statement-breakpoint
-- The Payout Challenge's config is gone with it (The Climb keeps its settings under "climb").
DELETE FROM "app_config" WHERE "key" = 'payout';