ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_party_id_parties_id_fk";
--> statement-breakpoint
DROP INDEX "chat_party_created_idx";--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "party_id";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "system";