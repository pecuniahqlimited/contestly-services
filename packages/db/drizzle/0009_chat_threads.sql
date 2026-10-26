CREATE TYPE "public"."chat_member_state" AS ENUM('active', 'request', 'declined');--> statement-breakpoint
CREATE TYPE "public"."chat_message_kind" AS ENUM('text', 'sticker', 'voice', 'system', 'party_card');--> statement-breakpoint
CREATE TYPE "public"."chat_thread_kind" AS ENUM('party', 'dm', 'crew');--> statement-breakpoint
CREATE TYPE "public"."voice_note_status" AS ENUM('pending', 'attached', 'expired');--> statement-breakpoint
CREATE TABLE "chat_members" (
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state" "chat_member_state" DEFAULT 'active' NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_members_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "chat_thread_kind" NOT NULL,
	"party_id" uuid,
	"dm_key" text,
	"crew_id" uuid,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_threads_party_id_unique" UNIQUE("party_id"),
	CONSTRAINT "chat_threads_dm_key_unique" UNIQUE("dm_key"),
	CONSTRAINT "chat_threads_crew_id_unique" UNIQUE("crew_id")
);
--> statement-breakpoint
CREATE TABLE "moderation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"user_id" uuid,
	"thread_id" uuid,
	"transcript" text,
	"provider" text,
	"detail" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"measured_ms" integer,
	"status" "voice_note_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attached_at" timestamp with time zone,
	"transcribed_at" timestamp with time zone,
	CONSTRAINT "voice_notes_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "kind" "chat_message_kind" DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "voice_note_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "card_party_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "client_msg_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_items" ADD CONSTRAINT "moderation_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_items" ADD CONSTRAINT "moderation_items_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_notes" ADD CONSTRAINT "voice_notes_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_notes" ADD CONSTRAINT "voice_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_members_user_idx" ON "chat_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_items_ref" ON "moderation_items" USING btree ("kind","ref_id");--> statement-breakpoint
CREATE INDEX "moderation_items_status_idx" ON "moderation_items" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "voice_notes_status_created_idx" ON "voice_notes" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_voice_note_id_voice_notes_id_fk" FOREIGN KEY ("voice_note_id") REFERENCES "public"."voice_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_card_party_id_parties_id_fk" FOREIGN KEY ("card_party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_thread_created_idx" ON "chat_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_client_msg" ON "chat_messages" USING btree ("user_id","client_msg_id");--> statement-breakpoint
-- Hand-written backfill: every party gets its thread, its host and seats become members (nothing unread), and
-- the party's existing lines move into it with their kind. 0010 then drops chat_messages.party_id and system.
INSERT INTO "chat_threads" ("kind", "party_id", "created_at", "last_message_at")
SELECT 'party', p."id", p."created_at", (SELECT max(m."created_at") FROM "chat_messages" m WHERE m."party_id" = p."id")
FROM "parties" p;--> statement-breakpoint
INSERT INTO "chat_members" ("thread_id", "user_id")
SELECT t."id", p."created_by_user_id" FROM "chat_threads" t JOIN "parties" p ON p."id" = t."party_id"
UNION
SELECT t."id", pp."user_id" FROM "chat_threads" t JOIN "party_players" pp ON pp."party_id" = t."party_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "chat_messages" m SET "thread_id" = t."id",
  "kind" = (CASE WHEN m."system" THEN 'system' WHEN m."sticker" IS NOT NULL THEN 'sticker' ELSE 'text' END)::"chat_message_kind"
FROM "chat_threads" t WHERE t."party_id" = m."party_id";
