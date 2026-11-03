/** GET /config: public (no session), the support contacts as configured (null when not), and the social numbers the app checks against. */
import { afterAll, describe, expect, it } from "vitest";
import { setSocialConfig, sql } from "@contestly/db";
import { DEFAULT_SOCIAL_CONFIG, publicConfigSchema } from "@contestly/shared";
import { testApp } from "./harness.js";

afterAll(async () => {
  await setSocialConfig(DEFAULT_SOCIAL_CONFIG);
  await sql.end();
});

const social = { cornerPostMaxChars: DEFAULT_SOCIAL_CONFIG.cornerPostMaxChars, yourPeopleDays: DEFAULT_SOCIAL_CONFIG.yourPeopleDays };

describe("GET /config", () => {
  it("answers without a session, with the support contacts", async () => {
    await setSocialConfig(DEFAULT_SOCIAL_CONFIG);
    const { app } = await testApp({ publicConfig: { support: { email: "help@contestly.example", whatsapp: "+2348012345678" } } });
    const res = await app.inject({ method: "GET", url: "/config" });
    expect([res.statusCode, publicConfigSchema.parse(res.json())]).toEqual([200, { support: { email: "help@contestly.example", whatsapp: "+2348012345678" }, social }]);
    await app.close();
    const { app: unset } = await testApp({ publicConfig: { support: { email: null, whatsapp: null } } });
    expect((await unset.inject({ method: "GET", url: "/config" })).json()).toEqual({ support: { email: null, whatsapp: null }, social });
    await unset.close();
  });

  it("carries the post cap and the your-people window from the admin's social config, as it is now", async () => {
    const { app } = await testApp({ publicConfig: { support: { email: null, whatsapp: null } } });
    await setSocialConfig({ ...DEFAULT_SOCIAL_CONFIG, cornerPostMaxChars: 280, yourPeopleDays: 14 });
    expect((await app.inject({ method: "GET", url: "/config" })).json().social).toEqual({ cornerPostMaxChars: 280, yourPeopleDays: 14 });
    await setSocialConfig(DEFAULT_SOCIAL_CONFIG);
    expect((await app.inject({ method: "GET", url: "/config" })).json().social).toEqual(social);
    await app.close();
  });
});
