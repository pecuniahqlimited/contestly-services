import { afterEach, describe, expect, it } from "vitest";
import { Unauthorized, assertAuthConfig, resolveUser } from "@contestly/auth";

const prod = { NODE_ENV: "production", FIREBASE_PROJECT_ID: "p", EMAIL_CODE_SECRET: "e", PHONE_HASH_SECRET: "h" };

describe("assertAuthConfig", () => {
  it("refuses AUTH_MODE=dev in production", () => {
    expect(() => assertAuthConfig({ ...prod, AUTH_MODE: "dev" })).toThrow(/refused/);
    expect(() => assertAuthConfig({ ...prod })).toThrow(/refused/); // unset means dev
  });
  it("refuses production without its sign-in secrets", () => {
    expect(() => assertAuthConfig({ NODE_ENV: "production", AUTH_MODE: "firebase", FIREBASE_PROJECT_ID: "p" })).toThrow(/EMAIL_CODE_SECRET, PHONE_HASH_SECRET/);
  });
  it("refuses an unknown mode", () => expect(() => assertAuthConfig({ AUTH_MODE: "open" })).toThrow(/AUTH_MODE/));
  it("accepts firebase in production, and dev locally", () => {
    expect(() => assertAuthConfig({ ...prod, AUTH_MODE: "firebase" })).not.toThrow();
    expect(() => assertAuthConfig({ AUTH_MODE: "dev", NODE_ENV: "development" })).not.toThrow();
  });
});

describe("resolveUser in firebase mode", () => {
  const before = process.env.AUTH_MODE;
  afterEach(() => { process.env.AUTH_MODE = before; });
  it("ignores x-dev-user entirely", async () => {
    process.env.AUTH_MODE = "firebase";
    await expect(resolveUser({ devUser: "tunde" })).rejects.toBeInstanceOf(Unauthorized);
  });
});
