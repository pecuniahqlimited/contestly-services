/** GET /health/deep against real Postgres and Valkey: every process's heartbeat, and a 503 when one goes stale. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@contestly/db";
import { HEALTH_PROCESSES, deepHealthSchema } from "@contestly/shared";
import { QUEUE_PREFIX, writeHeartbeat } from "@contestly/queue";
import { valkey } from "../src/redis.js";
import { testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
const beatAll = (at = Date.now()) => Promise.all(HEALTH_PROCESSES.map((p) => writeHeartbeat(valkey(), QUEUE_PREFIX, p, at)));

beforeAll(async () => { ({ app } = await testApp()); });
afterAll(async () => {
  await beatAll(); // leave them fresh for a running stack
  await app.close();
  await sql.end();
});

describe("GET /health/deep", () => {
  it("with no session: 200 and every process fresh once each has beaten", async () => {
    await beatAll();
    const res = await app.inject({ method: "GET", url: "/health/deep" });
    expect(res.statusCode, res.body).toBe(200);
    const body = deepHealthSchema.parse(res.json());
    expect(body).toMatchObject({ ok: true, postgres: { ok: true }, valkey: { ok: true } });
    for (const p of HEALTH_PROCESSES) expect(body.processes[p].ok).toBe(true);
  });

  it("a process that stopped beating: 503 naming it", async () => {
    await beatAll();
    await writeHeartbeat(valkey(), QUEUE_PREFIX, "realtime", Date.now() - 5 * 60_000);
    const res = await app.inject({ method: "GET", url: "/health/deep" });
    expect(res.statusCode).toBe(503);
    expect(res.json().processes.realtime).toMatchObject({ ok: false, ageSeconds: expect.any(Number) });
    expect(res.json().processes.worker.ok).toBe(true);
  });
});
