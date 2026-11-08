-- ADR 0017 §12: verified brands get the brand curate caps (curateHostType() returns "brand" for them), raised from a
-- person's to entry ₦5,000, host prize ₦500,000, pot ₦500,000 (the party limits' own ceilings). A new version of the
-- party template config, as an admin save would write it; every other rule and template is carried over unchanged.
INSERT INTO "party_template_configs" ("version", "config")
  SELECT "version" + 1, jsonb_set("config", '{rules,capsByHost,brand}', '{"maxEntryKobo": 500000, "maxHostPrizeKobo": 50000000, "maxPotKobo": 50000000}'::jsonb)
  FROM "party_template_configs" ORDER BY "version" DESC LIMIT 1;
