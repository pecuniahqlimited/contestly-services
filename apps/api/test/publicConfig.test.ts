import { describe, expect, it } from "vitest";
import { publicConfigFromEnv } from "../src/publicConfig.js";

describe("publicConfigFromEnv: the support contacts", () => {
  it("empty or unset is null; set is trimmed, the WhatsApp number without spaces or dashes", () => {
    expect(publicConfigFromEnv({})).toEqual({ support: { email: null, whatsapp: null } });
    expect(publicConfigFromEnv({ SUPPORT_EMAIL: " ", SUPPORT_WHATSAPP: "" })).toEqual({ support: { email: null, whatsapp: null } });
    expect(publicConfigFromEnv({ SUPPORT_EMAIL: " help@contestly.example ", SUPPORT_WHATSAPP: "+234 801-234-5678" }))
      .toEqual({ support: { email: "help@contestly.example", whatsapp: "+2348012345678" } });
  });

  it("a bad value stops the API at start", () => {
    expect(() => publicConfigFromEnv({ SUPPORT_EMAIL: "not an email" })).toThrow(/SUPPORT_EMAIL/);
    expect(() => publicConfigFromEnv({ SUPPORT_WHATSAPP: "08012345678" })).toThrow(/E.164/);
  });
});
