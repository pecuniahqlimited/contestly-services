-- Baseline (Oct 2026): the schema as db:push had built it. pgvector first: file_chunks and bank_questions use vector columns.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."account_kind" AS ENUM('cash', 'bonus');--> statement-breakpoint
CREATE TYPE "public"."bank_question_status" AS ENUM('active', 'pending_review', 'retired');--> statement-breakpoint
CREATE TYPE "public"."difficulty_source" AS ENUM('model_estimate', 'play_stats');--> statement-breakpoint
CREATE TYPE "public"."fulfilment_status" AS ENUM('awarded', 'arranged', 'delivered', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."funding_kind" AS ENUM('pooled', 'host');--> statement-breakpoint
CREATE TYPE "public"."generation_outcome" AS ENUM('accepted', 'rejected_invalid', 'rejected_verify', 'rejected_dedupe', 'rejected_safety');--> statement-breakpoint
CREATE TYPE "public"."party_difficulty" AS ENUM('easy', 'mixed', 'hard', 'brutal');--> statement-breakpoint
CREATE TYPE "public"."party_file_status" AS ENUM('parsing', 'parsed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."party_mode" AS ENUM('sealed', 'curate');--> statement-breakpoint
CREATE TYPE "public"."party_question_status" AS ENUM('pending', 'played', 'voided', 'draft');--> statement-breakpoint
CREATE TYPE "public"."party_status" AS ENUM('open', 'live', 'finished', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."prize_kind" AS ENUM('cash', 'noncash');--> statement-breakpoint
CREATE TYPE "public"."question_event_kind" AS ENUM('flag', 'void', 'replace', 'approve', 'edit', 'swap', 'regenerate');--> statement-breakpoint
CREATE TYPE "public"."question_format" AS ENUM('pick_one', 'pick_all', 'order', 'match', 'picture');--> statement-breakpoint
CREATE TYPE "public"."questions_status" AS ENUM('not_started', 'generating', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."visibility_kind" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TABLE "app_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"format" "question_format" NOT NULL,
	"payload" jsonb NOT NULL,
	"explanation" text,
	"category_tag" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"difficulty" real NOT NULL,
	"difficulty_source" "difficulty_source" DEFAULT 'model_estimate' NOT NULL,
	"status" "bank_question_status" DEFAULT 'active' NOT NULL,
	"origin" text DEFAULT 'generated' NOT NULL,
	"source_chunk_id" uuid,
	"times_played" integer DEFAULT 0 NOT NULL,
	"times_answered" integer DEFAULT 0 NOT NULL,
	"correctness_sum" integer DEFAULT 0 NOT NULL,
	"answered_ms_sum" bigint DEFAULT 0 NOT NULL,
	"times_skipped" integer DEFAULT 0 NOT NULL,
	"flag_count" integer DEFAULT 0 NOT NULL,
	"retired_reason" text,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_played_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"user_id" uuid,
	"text" text,
	"sticker" text,
	"system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" uuid NOT NULL,
	"followee_id" uuid NOT NULL,
	"notify" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_id_followee_id_pk" PRIMARY KEY("follower_id","followee_id")
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "account_kind" NOT NULL,
	"balance_kobo" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"type" text NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"brief" text DEFAULT '' NOT NULL,
	"category" text NOT NULL,
	"difficulty" "party_difficulty" DEFAULT 'mixed' NOT NULL,
	"formats" "question_format"[] DEFAULT '{pick_one,pick_all,order,match,picture}'::question_format[] NOT NULL,
	"spec_summary" text,
	"mode" "party_mode" DEFAULT 'sealed' NOT NULL,
	"questions_status" "questions_status" DEFAULT 'not_started' NOT NULL,
	"questions_error" text,
	"forge_progress" jsonb,
	"entry_kobo" integer DEFAULT 0 NOT NULL,
	"max_players" integer NOT NULL,
	"question_count" integer DEFAULT 5 NOT NULL,
	"question_seconds" integer DEFAULT 15 NOT NULL,
	"funding" "funding_kind" NOT NULL,
	"host_pool_kobo" integer DEFAULT 0 NOT NULL,
	"prize_kind" "prize_kind" DEFAULT 'cash' NOT NULL,
	"prize_text" text,
	"prize_value_kobo" integer,
	"split" integer[] NOT NULL,
	"visibility" "visibility_kind" DEFAULT 'public' NOT NULL,
	"cover_color" text DEFAULT '#7B5CFF' NOT NULL,
	"cover_emoji" text DEFAULT '🎉' NOT NULL,
	"status" "party_status" DEFAULT 'open' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"live_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"play_stats_recorded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_answers" (
	"party_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"answer" jsonb,
	"answered_ms" integer,
	"correctness_pct" integer DEFAULT 0 NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_answers_question_id_user_id_pk" PRIMARY KEY("question_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "party_draft_views" (
	"party_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"first_viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_draft_views_party_id_user_id_pk" PRIMARY KEY("party_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "party_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"status" "party_file_status" DEFAULT 'parsing' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_players" (
	"party_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"score" integer,
	"rank" integer,
	"prize_kobo" integer,
	CONSTRAINT "party_players_party_id_user_id_pk" PRIMARY KEY("party_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "party_question_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"kind" "question_event_kind" NOT NULL,
	"user_id" uuid,
	"reason" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"format" "question_format" NOT NULL,
	"payload" jsonb NOT NULL,
	"seconds" integer NOT NULL,
	"explanation" text,
	"status" "party_question_status" DEFAULT 'pending' NOT NULL,
	"reserve" boolean DEFAULT false NOT NULL,
	"source_ref" text,
	"host_authored" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prize_fulfilments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"winner_user_id" uuid NOT NULL,
	"host_user_id" uuid NOT NULL,
	"prize_text" text NOT NULL,
	"status" "fulfilment_status" DEFAULT 'awarded' NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"bank_question_id" uuid,
	"brief" text NOT NULL,
	"spec" jsonb NOT NULL,
	"draft" jsonb NOT NULL,
	"verify" jsonb,
	"dedupe" jsonb,
	"difficulty" jsonb,
	"safety" jsonb,
	"outcome" "generation_outcome" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firebase_uid" text,
	"phone" text,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_emoji" text DEFAULT '😎' NOT NULL,
	"bio" text,
	"interests" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_brand" boolean DEFAULT false NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"streak_days" integer DEFAULT 0 NOT NULL,
	"last_played_on" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_firebase_uid_unique" UNIQUE("firebase_uid"),
	CONSTRAINT "users_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_file_id_party_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."party_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_id_users_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_answers" ADD CONSTRAINT "party_answers_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_answers" ADD CONSTRAINT "party_answers_question_id_party_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."party_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_answers" ADD CONSTRAINT "party_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_draft_views" ADD CONSTRAINT "party_draft_views_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_draft_views" ADD CONSTRAINT "party_draft_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_files" ADD CONSTRAINT "party_files_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_files" ADD CONSTRAINT "party_files_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_players" ADD CONSTRAINT "party_players_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_players" ADD CONSTRAINT "party_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_question_events" ADD CONSTRAINT "party_question_events_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_question_events" ADD CONSTRAINT "party_question_events_question_id_party_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."party_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_question_events" ADD CONSTRAINT "party_question_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_questions" ADD CONSTRAINT "party_questions_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_fulfilments" ADD CONSTRAINT "prize_fulfilments_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_fulfilments" ADD CONSTRAINT "prize_fulfilments_winner_user_id_users_id_fk" FOREIGN KEY ("winner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_fulfilments" ADD CONSTRAINT "prize_fulfilments_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_generations" ADD CONSTRAINT "question_generations_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_generations" ADD CONSTRAINT "question_generations_bank_question_id_bank_questions_id_fk" FOREIGN KEY ("bank_question_id") REFERENCES "public"."bank_questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_questions_status_category_idx" ON "bank_questions" USING btree ("status","category_tag");--> statement-breakpoint
CREATE INDEX "bank_questions_embedding_idx" ON "bank_questions" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "chat_party_created_idx" ON "chat_messages" USING btree ("party_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "file_chunks_file_idx" ON "file_chunks" USING btree ("file_id","idx");--> statement-breakpoint
CREATE INDEX "follows_followee_idx" ON "follows" USING btree ("followee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_user_kind" ON "ledger_accounts" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "parties_status_starts_idx" ON "parties" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "party_answers_party_idx" ON "party_answers" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "party_files_party_idx" ON "party_files" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "party_question_events_party_idx" ON "party_question_events" USING btree ("party_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "party_questions_party_idx" ON "party_questions" USING btree ("party_id","idx");--> statement-breakpoint
CREATE UNIQUE INDEX "prize_fulfilments_party" ON "prize_fulfilments" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "question_generations_party_idx" ON "question_generations" USING btree ("party_id");