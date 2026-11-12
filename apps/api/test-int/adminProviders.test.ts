/** GET/PUT /admin/questions/providers: one shared response shape (adminProvidersSchema), the save logged with its reason. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { adminActions, db, sql, type User } from "@contestly/db";
import { adminProvidersSchema } from "@contestly/shared";
import { as, makeUser, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let admin: User;
beforeAll(async () => {
  ({ app } = await testApp());
  admin = await makeUser(`provadmin${Date.now() % 100000}`, { isAdmin: true });
});
afterAll(async () => {
  await app.close();
  await sql.end();
});

describe("the providers settings", () => {
  it("GET and PUT answer the same shape; a save is logged and an unknown field is dropped", async () => {
    const got = await app.inject({ method: "GET", url: "/admin/questions/providers", headers: as(admin) });
    expect(got.statusCode).toBe(200);
    const before = adminProvidersSchema.parse(got.json());
    expect(Object.keys(got.json()).sort()).toEqual(["config", "paidCapMicros"]);
    expect(before.paidCapMicros).toBe(0);

    const config = { ...before.config, verifyBatchSize: before.config.verifyBatchSize === 10 ? 8 : 10 };
    const put = await app.inject({ method: "PUT", url: "/admin/questions/providers", headers: as(admin), payload: { config, reason: "test the response shape" } });
    expect(put.statusCode, put.body).toBe(200);
    expect(adminProvidersSchema.parse(put.json())).toEqual({ config, paidCapMicros: 0 });
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.action, "config.question_providers"), eq(adminActions.adminUserId, admin.id))).orderBy(desc(adminActions.createdAt)).limit(1);
    expect(log).toMatchObject({ reason: "test the response shape" });

    // Put it back as it was.
    await app.inject({ method: "PUT", url: "/admin/questions/providers", headers: as(admin), payload: { config: before.config, reason: "put back after the test" } });
  });
});
