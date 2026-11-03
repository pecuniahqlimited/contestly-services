ALTER TABLE "parties" ADD COLUMN "progress_recorded_at" timestamp with time zone;
--> statement-breakpoint
-- Parties finished before this were recorded inside settlement (0038 backfilled played_with); mark them done.
UPDATE "parties" SET "progress_recorded_at" = coalesce("ended_at", now()) WHERE "status" = 'finished';
