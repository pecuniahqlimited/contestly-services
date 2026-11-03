ALTER TABLE "linked_issue_clearances" ADD COLUMN "covered_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "linked_payment_issue_cleared_at";