/** GET /health/deep's verdict (health.ts) with fake probes: what's up, what's stale, and what a hung store does. */
import { describe, expect, it } from "vitest";
import { HEALTH_PROCESSES, HEARTBEAT_FRESH_SECONDS, deepHealthSchema, type HealthProcess } from "@contestly/shared";
import { deepHealth, type DeepHealthDeps } from "../src/health.js";

const NOW = Date.UTC(2026, 10, 11, 12);
const fresh = (): Record<HealthProcess, number | null> => Object.fromEntries(HEALTH_PROCESSES.map((p) => [p, NOW - 5_000])) as Record<HealthProcess, number | null>;
const deps = (over: Partial<DeepHealthDeps> = {}): DeepHealthDeps => ({
  pingPostgres: async () => 1, pingValkey: async () => "PONG", heartbeats: async () => fresh(), now: () => NOW, timeoutMs: 50, ...over,
});
const never = () => new Promise(() => {});

describe("the deep health check", () => {
  it("everything up: ok, each process with when it last beat", async () => {
    const r = deepHealthSchema.parse(await deepHealth(deps()));
    expect(r.ok).toBe(true);
    expect(r.postgres.ok && r.valkey.ok).toBe(true);
    for (const p of HEALTH_PROCESSES) expect(r.processes[p]).toEqual({ ok: true, lastBeatAt: new Date(NOW - 5_000).toISOString(), ageSeconds: 5 });
  });

  it("a process silent past the freshness limit, or never seen: not ok", async () => {
    const beats = { ...fresh(), worker: NOW - (HEARTBEAT_FRESH_SECONDS + 1) * 1000, questions: null };
    const r = await deepHealth(deps({ heartbeats: async () => beats }));
    expect(r.ok).toBe(false);
    expect(r.processes.worker).toMatchObject({ ok: false, ageSeconds: HEARTBEAT_FRESH_SECONDS + 1 });
    expect(r.processes.questions).toEqual({ ok: false, lastBeatAt: null, ageSeconds: null });
    expect(r.processes.api.ok && r.processes.realtime.ok).toBe(true);
    // Exactly at the limit is still fresh.
    const edge = await deepHealth(deps({ heartbeats: async () => ({ ...fresh(), worker: NOW - HEARTBEAT_FRESH_SECONDS * 1000 }) }));
    expect(edge.ok).toBe(true);
  });

  it("Postgres refusing or hanging: not ok, answered within the timeout", async () => {
    expect((await deepHealth(deps({ pingPostgres: async () => { throw new Error("ECONNREFUSED"); } }))).postgres).toEqual({ ok: false, latencyMs: null });
    const started = Date.now();
    const r = await deepHealth(deps({ pingPostgres: never }));
    expect(r).toMatchObject({ ok: false, postgres: { ok: false } });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("Valkey hanging: not ok, and no process can be vouched for", async () => {
    const r = await deepHealth(deps({ pingValkey: never }));
    expect(r.valkey.ok).toBe(false);
    for (const p of HEALTH_PROCESSES) expect(r.processes[p].ok).toBe(false);
  });

  it("says nothing but up or down and when: no hosts, errors or versions", async () => {
    const r = await deepHealth(deps({ pingPostgres: async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"); } }));
    expect(JSON.stringify(r)).not.toMatch(/10\.0\.0\.5|hunter2|ECONNREFUSED/);
    expect(Object.keys(r).sort()).toEqual(["checkedAt", "ok", "postgres", "processes", "valkey"]);
  });
});
