import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";

describe("package exports", () => {
  it("@contestly/shared/nudges resolves by its subpath (the built package) to the same nudges contract as the root", async () => {
    const nudges = await import("@contestly/shared/nudges");
    for (const name of ["NUDGE_KINDS", "NUDGE_CATEGORIES", "DEEP_LINKS", "parseThreadLink", "nudgeMessageSchema", "notificationSettingsSchema", "quietHoursIn"]) {
      expect(nudges[name as keyof typeof nudges], name).toBeDefined();
      expect(Object.keys(root)).toContain(name);
    }
  });

  it("@contestly/shared/templates resolves by its subpath to the same templates contract as the root", async () => {
    const templates = await import("@contestly/shared/templates");
    for (const name of ["hostQuestionSchema", "partyTemplateSchema", "partyTemplatesConfigSchema", "distractorRequestSchema", "templatePrefill", "maxHostQuestions", "checkHostText", "CURATE_HOST_TYPES"]) {
      expect(templates[name as keyof typeof templates], name).toBeDefined();
      expect(Object.keys(root)).toContain(name);
    }
  });

  it("@contestly/shared/brands resolves by its subpath to the brands contract on the root", async () => {
    const brands = await import("@contestly/shared/brands");
    for (const name of ["ACT_AS_HEADER", "BRAND_ROLES", "BRAND_ROLE_CAPABILITIES", "brandRoleCan", "createBrandSchema", "brandSettingsSchema", "prizeFulfilmentSchema", "adminBrandDetailSchema"]) {
      expect(brands[name as keyof typeof brands], name).toBeDefined();
      expect(Object.keys(root)).toContain(name);
    }
  });
});
