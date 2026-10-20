-- Hand-edited: drizzle-kit would drop and recreate prize_kind (failing on 'noncash' rows) and drop the old prize
-- columns before their prizes were moved. Instead: rename the enum value, add the new one, and backfill first.
ALTER TYPE "public"."prize_kind" RENAME VALUE 'noncash' TO 'product';--> statement-breakpoint
ALTER TYPE "public"."prize_kind" ADD VALUE 'experience';--> statement-breakpoint
CREATE TABLE "party_prizes" (
	"party_id" uuid NOT NULL,
	"place" integer NOT NULL,
	"text" text NOT NULL,
	"value_kobo" integer,
	CONSTRAINT "party_prizes_party_id_place_pk" PRIMARY KEY("party_id","place")
);
--> statement-breakpoint
ALTER TABLE "party_prizes" ADD CONSTRAINT "party_prizes_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- An existing goods party had one prize, for 1st place.
INSERT INTO "party_prizes" ("party_id", "place", "text", "value_kobo")
	SELECT "id", 1, "prize_text", "prize_value_kobo" FROM "parties" WHERE "prize_kind" = 'product' AND "prize_text" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "limits" jsonb;--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "prize_text";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "prize_value_kobo";--> statement-breakpoint
-- Fulfilments: one per winning place; the existing ones were 1st place.
DROP INDEX "prize_fulfilments_party";--> statement-breakpoint
ALTER TABLE "prize_fulfilments" ADD COLUMN "place" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "prize_fulfilments" ADD COLUMN "prize_value_kobo" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "prize_fulfilments_party_place" ON "prize_fulfilments" USING btree ("party_id","place");
