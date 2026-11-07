-- Hand-edited: rows written before this column existed were last seen (as far as we know) when first seen. A plain
-- DEFAULT now() would make every old IP look used today, and link strangers around the next party (ADR 0015).
ALTER TABLE "user_signals" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
UPDATE "user_signals" SET "last_seen_at" = "first_seen_at";--> statement-breakpoint
ALTER TABLE "user_signals" ALTER COLUMN "last_seen_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "user_signals" ALTER COLUMN "last_seen_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "user_signals_value_seen_idx" ON "user_signals" USING btree ("kind","value","last_seen_at");