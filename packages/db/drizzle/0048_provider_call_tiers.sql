ALTER TABLE "provider_calls" ADD COLUMN "tier" text DEFAULT 'paid' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "requests" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "provider_calls_model_created_idx" ON "provider_calls" USING btree ("model","created_at");