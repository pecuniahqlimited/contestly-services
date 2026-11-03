ALTER TABLE "users" ADD COLUMN "archived_email_key" text;--> statement-breakpoint
CREATE INDEX "users_archived_email_key_idx" ON "users" USING btree ("archived_email_key");--> statement-breakpoint
CREATE INDEX "users_archived_phone_hmac_idx" ON "users" USING btree ("archived_phone_hmac");--> statement-breakpoint
UPDATE "users" SET "archived_email_key" = CASE
  WHEN split_part(lower(trim("archived_email")), '@', 2) IN ('gmail.com', 'googlemail.com')
    THEN replace(split_part(split_part(lower(trim("archived_email")), '@', 1), '+', 1), '.', '') || '@gmail.com'
  ELSE lower(trim("archived_email")) END
WHERE "archived_email" IS NOT NULL;
