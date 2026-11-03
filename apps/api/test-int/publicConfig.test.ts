/** GET /config: public (no session), the support contacts as configured, null when not. */
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@contestly/db";
import { publicConfigSchema } from "@contestly/shared";
import { testApp } from "./harness.js";

afterAll(async () => { await sql.end(); });

describe("GET /config", () => {
  it("answers without a session, with the support contacts", async () => {
    const { app } = await testApp({ publicConfig: { support: { email: "help@contestly.example", whatsapp: "+2348012345678" } } });
    const res = await app.inject({ method: "GET", url: "/config" });
    expect([res.statusCode, publicConfigSchema.parse(res.json())]).toEqual([200, { support: { email: "help@contestly.example", whatsapp: "+2348012345678" } }]);
    await app.close();
    const { app: unset } = await testApp({ publicConfig: { support: { email: null, whatsapp: null } } });
    expect((await unset.inject({ method: "GET", url: "/config" })).json()).toEqual({ support: { email: null, whatsapp: null } });
    await unset.close();
  });
});
