CREATE TABLE "admin_alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"mode" text NOT NULL,
	"kind" text,
	"alert_ids" uuid[] NOT NULL,
	"occurrences" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"subject" text NOT NULL,
	"details" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"delivered" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acknowledged_by_user_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"ack_note" text
);
--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_alert_deliveries_clock_idx" ON "admin_alert_deliveries" USING btree ("channel","mode","kind","sent_at");--> statement-breakpoint
CREATE INDEX "admin_alerts_dedupe_idx" ON "admin_alerts" USING btree ("dedupe_key","window_ends_at");--> statement-breakpoint
CREATE INDEX "admin_alerts_open_idx" ON "admin_alerts" USING btree ("severity","last_seen_at") WHERE acknowledged_at is null;--> statement-breakpoint
CREATE INDEX "admin_alerts_kind_idx" ON "admin_alerts" USING btree ("kind","last_seen_at");--> statement-breakpoint
CREATE INDEX "admin_alerts_ref_idx" ON "admin_alerts" USING btree ("ref_type","ref_id");