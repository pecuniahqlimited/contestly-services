CREATE TABLE "payment_webhook_rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"source_ip" text NOT NULL,
	"reason" text NOT NULL,
	"head" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "payment_webhook_rejections_created_idx" ON "payment_webhook_rejections" USING btree ("created_at");