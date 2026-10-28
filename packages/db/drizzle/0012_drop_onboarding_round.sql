-- Onboarding v2 (roadmap 5c, ADR 0009): the onboarding coins round is gone. Its tables, the old "why"
-- pick, and the starter questions the seed put in the bank for it (origin 'seed', placeholder
-- embeddings; dev data only). Past onboarding_bonus ledger entries stay: the ledger is append-only.
DROP TABLE "onboarding_configs" CASCADE;--> statement-breakpoint
DROP TABLE "onboarding_devices" CASCADE;--> statement-breakpoint
DROP TABLE "onboarding_rounds" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "why";--> statement-breakpoint
DELETE FROM "bank_questions" b WHERE b."origin" = 'seed'
  AND NOT EXISTS (SELECT 1 FROM "question_generations" g WHERE g."bank_question_id" = b."id");
