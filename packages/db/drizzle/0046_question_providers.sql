CREATE TABLE "provider_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"step" text NOT NULL,
	"party_id" uuid,
	"job" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"search_queries" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"outcome" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"verdict" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_questions" ADD COLUMN "embedding_model" text DEFAULT 'mock' NOT NULL;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_calls_created_idx" ON "provider_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "provider_calls_party_idx" ON "provider_calls" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "bank_questions_embedding_model_idx" ON "bank_questions" USING btree ("embedding_model");--> statement-breakpoint
-- Chunks embedded before ADR 0016 came from the mock embedder.
UPDATE "file_chunks" SET "embedding_model" = 'mock' WHERE "embedding" IS NOT NULL;