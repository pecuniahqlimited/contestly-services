-- ADR 0015: the curate caps become per host type (capsByHost: person, brand), and every host-written rule is stated
-- in the database. Version 1 (0049) stored four rules; the rest were read from defaults in code. This restates each
-- stored rule set (the template configs and the parties' copies) in the new shape with every rule explicit, using the
-- values they were read with, so nothing is read from code at runtime. Brands start at a person's caps (row 8 raises
-- them in config). Meaning is unchanged; only the representation moves.
CREATE FUNCTION "pg_temp"."curate_rules"(r jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'capsByHost', jsonb_build_object('person', caps, 'brand', caps),
    'maxHostShareBps', coalesce(r->'maxHostShareBps', '5000'),
    'outlierMarginPct', coalesce(r->'outlierMarginPct', '30'),
    'recentBlockDays', coalesce(r->'recentBlockDays', '7'),
    'repeatWinsMax', coalesce(r->'repeatWinsMax', '2'),
    'repeatWindowDays', coalesce(r->'repeatWindowDays', '30'),
    'newAccountDays', coalesce(r->'newAccountDays', '14'),
    'minFinishedParties', coalesce(r->'minFinishedParties', '5'),
    'unlinkedMarginPct', coalesce(r->'unlinkedMarginPct', '50'),
    'ipWindowHoursBefore', coalesce(r->'ipWindowHoursBefore', '24'),
    'maxAccountsPerIp', coalesce(r->'maxAccountsPerIp', '5'))
  FROM (SELECT jsonb_build_object(
    'maxEntryKobo', coalesce(r->'maxEntryKobo', '100000'),
    'maxHostPrizeKobo', coalesce(r->'maxHostPrizeKobo', '5000000'),
    'maxPotKobo', coalesce(r->'maxPotKobo', '5000000')) AS caps) c
$$;--> statement-breakpoint
UPDATE "party_template_configs" SET "config" = jsonb_set("config", '{rules}', "pg_temp"."curate_rules"("config"->'rules')) WHERE NOT ("config"->'rules') ? 'capsByHost';--> statement-breakpoint
UPDATE "parties" SET "host_rules" = "pg_temp"."curate_rules"("host_rules") WHERE "host_rules" IS NOT NULL AND NOT "host_rules" ? 'capsByHost';--> statement-breakpoint
-- Parties from before templates had no copy; now that every curate party is checked at settlement, they keep the current one.
UPDATE "parties" SET "host_rules" = (SELECT "config"->'rules' FROM "party_template_configs" ORDER BY "version" DESC LIMIT 1) WHERE "host_rules" IS NULL;
