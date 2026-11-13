-- Who wrote each bank question (11 Nov 2026). Before this, real generators recorded themselves on the generation
-- record (draft.generatedBy) and the mock generator didn't, so a banked question with a recorded provider takes
-- it, and one without was written by the mock generator (admins' own inserts are origin 'sim' or edits of these).
ALTER TABLE "bank_questions" ADD COLUMN "written_by" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
UPDATE "bank_questions" b SET "written_by" = coalesce(
  (SELECT g."draft"->'generatedBy'->>'provider' FROM "question_generations" g
    WHERE g."bank_question_id" = b."id" AND g."draft"->'generatedBy'->>'provider' IS NOT NULL LIMIT 1),
  'mock');--> statement-breakpoint
-- Mock-written questions the re-embed job moved into a real model's space were being served to free and paid
-- parties as if a model had written them. Retire them (an admin restore brings one back); the mock's own rows stay.
UPDATE "bank_questions" SET "status" = 'retired', "retired_reason" = 'mock_written', "retired_at" = now()
  WHERE "written_by" = 'mock' AND "embedding_model" <> 'mock' AND "status" <> 'retired';
