CREATE TABLE "blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id")
);
--> statement-breakpoint
CREATE TABLE "person_mutes" (
	"user_id" uuid NOT NULL,
	"muted_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_mutes_user_id_muted_user_id_pk" PRIMARY KEY("user_id","muted_user_id")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"category" text,
	"outcome" text,
	"item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "moderation_items" ALTER COLUMN "status" SET DEFAULT 'open';--> statement-breakpoint
ALTER TABLE "admin_ban_requests" ADD COLUMN "until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_ban_requests" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "corner_post_replies" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "corner_posts" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_items" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "moderation_items" ADD COLUMN "report_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_items" ADD COLUMN "last_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_items" ADD COLUMN "held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_items" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "moderation_items" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_items" ADD COLUMN "resolved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banned_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ban_category" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chat_timeout_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_mutes" ADD CONSTRAINT "person_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_mutes" ADD CONSTRAINT "person_mutes_muted_user_id_users_id_fk" FOREIGN KEY ("muted_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_item_id_moderation_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."moderation_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notices" ADD CONSTRAINT "user_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notices" ADD CONSTRAINT "user_notices_item_id_moderation_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."moderation_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_blocked_idx" ON "blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_item_reporter" ON "reports" USING btree ("item_id","reporter_id");--> statement-breakpoint
CREATE INDEX "reports_created_idx" ON "reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_notices_user_idx" ON "user_notices" USING btree ("user_id","seen_at");--> statement-breakpoint
ALTER TABLE "moderation_items" ADD CONSTRAINT "moderation_items_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_items_user_idx" ON "moderation_items" USING btree ("user_id");--> statement-breakpoint
-- Hand-written (ADR 0014): the queue's statuses are open, actioned and dismissed; voice transcripts waited as 'pending'.
UPDATE "moderation_items" SET "status" = 'open' WHERE "status" = 'pending';--> statement-breakpoint
-- Corner reply reports were kept in detail.reports (one entry per report): each reporter becomes one reports row,
-- the reply's text its snapshot, and the count the distinct reporters.
INSERT INTO "reports" ("item_id", "reporter_id", "reason", "note", "created_at")
SELECT DISTINCT ON (m.id, (r->>'by')::uuid) m.id, (r->>'by')::uuid, 'other', coalesce(r->>'reason', 'reported before reasons existed'), coalesce((r->>'at')::timestamptz, m.created_at)
FROM "moderation_items" m, jsonb_array_elements(coalesce(m.detail->'reports', '[]'::jsonb)) r
WHERE m.kind = 'corner_reply' AND r ? 'by'
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "moderation_items" m SET
  "report_count" = (SELECT count(*) FROM "reports" r WHERE r.item_id = m.id),
  "last_reported_at" = (SELECT max(r.created_at) FROM "reports" r WHERE r.item_id = m.id),
  "snapshot" = jsonb_build_object('text', m.transcript)
WHERE m.kind = 'corner_reply';
