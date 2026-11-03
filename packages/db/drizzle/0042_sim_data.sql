ALTER TABLE "corners" ADD COLUMN "is_sim" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "is_sim" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_sim" boolean DEFAULT false NOT NULL;