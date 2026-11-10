import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
    for (const name of ["hostQuestionSchema", "partyTemplateSchema", "partyTemplatesConfigSchema", "distractorRequestSchema", "templatePrefill", "maxHostQuestions", "checkHostText", "CURATE_HOST_TYPES", "templateRefSchema", "MAX_HOST_QUESTIONS", "DISTRACTOR_COUNT"]) {
      expect(templates[name as keyof typeof templates], name).toBeDefined();
      expect(Object.keys(root)).toContain(name);
    }
  });

  // createPartySchema needs a host question and a template ref; it takes them (and the root re-exports them) from
  // hostQuestion.ts, so a tree-shaking bundler can leave templates.ts out of the app's startup (measured: 378.9 → 377.9 KB).
  it("the root takes nothing from templates.ts itself, so an app that tree-shakes leaves templates out of its startup", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index.match(/from "\.\/templates\.js"/g)).toEqual(['from "./templates.js"']);
    expect(index).toContain('export * from "./templates.js"');
    expect(index).toContain('export * from "./hostQuestion.js"');
  });

  it("@contestly/shared/brands resolves by its subpath to the brands contract on the root", async () => {
    const brands = await import("@contestly/shared/brands");
    for (const name of ["ACT_AS_HEADER", "BRAND_ROLES", "BRAND_ROLE_CAPABILITIES", "brandRoleCan", "createBrandSchema", "brandSettingsSchema", "prizeFulfilmentSchema", "adminBrandDetailSchema"]) {
      expect(brands[name as keyof typeof brands], name).toBeDefined();
      expect(Object.keys(root)).toContain(name);
    }
  });

  it("@contestly/shared/images resolves by its subpath to the images contract on the root", async () => {
    const images = await import("@contestly/shared/images");
    for (const name of ["IMAGE_CONTENT_TYPES", "IMAGE_PURPOSES", "imageKeySchema", "imageUploadRequestSchema", "imageUploadResponseSchema", "parseImageKey"]) {
      expect(images[name as keyof typeof images], name).toBeDefined();
      expect(Object.keys(root)).toContain(name);
    }
  });

  // The root names a corner viewer's brand role; it takes BRAND_ROLES from brandRoles.ts, so a tree-shaking app
  // leaves brands.ts, and images.ts (only brands.ts imports it), out of its startup.
  it("the root takes nothing from brands.ts or images.ts itself, only re-exports them", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index.match(/from "\.\/brands\.js"/g)).toEqual(['from "./brands.js"']);
    expect(index.match(/from "\.\/images\.js"/g)).toEqual(['from "./images.js"']);
    expect(index).toContain('export * from "./brandRoles.js"');
  });
});
