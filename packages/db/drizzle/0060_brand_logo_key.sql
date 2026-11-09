-- A brand's logo is an upload now (images/brand_logo/<brand id>/…), not a link. The links set before this weren't
-- uploads and are dropped; no brand is live yet. A brand's checklist shows its logo missing until one is uploaded.
ALTER TABLE "brands" ADD COLUMN "logo_key" text;--> statement-breakpoint
ALTER TABLE "brands" DROP COLUMN "logo_url";