import { describe, expect, it } from "vitest";
import { limitsFromEnv } from "../src/limits.js";

describe("limitsFromEnv", () => {
  it("uses the production defaults when nothing is set", () => {
    expect(limitsFromEnv({})).toEqual({
      userPerMinute: 600, ipPerMinute: 300, codeSendsPerIpPerHour: 500, codeSendsPerEmailPerHour: 5,
      codeChecksPerIpPer10Min: 200, codeChecksPerEmailPer10Min: 15, oauthPerIpPer10Min: 120, guestsPerIpPerHour: 300,
      codeSendsAlertPerHour: 2000, reportsPerHour: 20,
    });
  });
  it("reads each from the environment, and refuses nonsense", () => {
    expect(limitsFromEnv({ RATE_LIMIT_USER_PER_MINUTE: "5", RATE_LIMIT_IP_PER_MINUTE: "" })).toMatchObject({ userPerMinute: 5, ipPerMinute: 300 });
    expect(() => limitsFromEnv({ RATE_LIMIT_USER_PER_MINUTE: "lots" })).toThrow(/RATE_LIMIT_USER_PER_MINUTE/);
    expect(() => limitsFromEnv({ RATE_LIMIT_IP_PER_MINUTE: "0" })).toThrow();
  });
});
