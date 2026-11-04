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
});
