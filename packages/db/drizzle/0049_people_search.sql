-- People search: fold case and accents ("Adébáyọ̀" → "adebayo") the same way in the index and the query.
-- unaccent() is only STABLE (its dictionary could change), so it's wrapped with the dictionary named, as
-- IMMUTABLE, which an expression index needs. pg_trgm serves "any word of the name" matches.
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE OR REPLACE FUNCTION contestly_fold(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, lower($1)) $$;--> statement-breakpoint
CREATE INDEX "users_handle_fold_idx" ON "users" USING btree (contestly_fold("handle") text_pattern_ops);--> statement-breakpoint
CREATE INDEX "users_name_fold_idx" ON "users" USING btree (contestly_fold("display_name") text_pattern_ops);--> statement-breakpoint
CREATE INDEX "users_name_fold_trgm_idx" ON "users" USING gin (contestly_fold("display_name") gin_trgm_ops);