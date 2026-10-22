-- Firebase uids move to user_identities (ADR 0006). Dev-header users ("dev:<handle>") are found by handle and need no identity.
INSERT INTO "user_identities" ("provider", "external_id", "user_id")
  SELECT 'firebase', "firebase_uid", "id" FROM "users" WHERE "firebase_uid" IS NOT NULL AND "firebase_uid" NOT LIKE 'dev:%'
  ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_firebase_uid_unique";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "firebase_uid";
