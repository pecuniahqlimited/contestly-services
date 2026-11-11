/**
 * GET /health/deep: each process's heartbeat (packages/queue/src/heartbeat.ts) fresh within HEARTBEAT_FRESH_SECONDS,
 * and Postgres and Valkey answering. The one check that sees a whole process, or the whole server, down: an
 * external uptime monitor hits it every minute (deploy notes). Each probe has a timeout, so a hung dependency is a
 * 503, not a hung request.
 */
import { HEALTH_PROCESSES, HEARTBEAT_FRESH_SECONDS, type DeepHealth, type HealthProcess } from "@contestly/shared";

/** A probe slower than this counts as down. */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

export interface DeepHealthDeps {
  pingPostgres(): Promise<unknown>;
  pingValkey(): Promise<unknown>;
  heartbeats(): Promise<Record<HealthProcess, number | null>>;
  now?: () => number;
  timeoutMs?: number;
}

/** Resolves with the probe's result and latency, or rejects after `ms`. */
async function timed<T>(ms: number, probe: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms); });
  try {
    return { value: await Promise.race([probe(), late]), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export async function deepHealth(deps: DeepHealthDeps): Promise<DeepHealth> {
  const now = deps.now ?? Date.now;
  const ms = deps.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  const probe = async (run: () => Promise<unknown>) => {
    try {
      return { ok: true, latencyMs: (await timed(ms, run)).latencyMs };
    } catch (err) {
      console.error("[health] probe failed", err instanceof Error ? err.message : err);
      return { ok: false, latencyMs: null };
    }
  };
  const [postgres, valkey] = await Promise.all([probe(deps.pingPostgres), probe(deps.pingValkey)]);
  // Without Valkey no heartbeat can be read: every process is unknown, so down.
  let beats: Record<HealthProcess, number | null> | null = null;
  if (valkey.ok) beats = await timed(ms, deps.heartbeats).then((r) => r.value, () => null);
  const t = now();
  const processes = Object.fromEntries(HEALTH_PROCESSES.map((p) => {
    const at = beats?.[p] ?? null;
    const ageSeconds = at === null ? null : Math.max(0, Math.floor((t - at) / 1000));
    return [p, { ok: ageSeconds !== null && ageSeconds <= HEARTBEAT_FRESH_SECONDS, lastBeatAt: at === null ? null : new Date(at).toISOString(), ageSeconds }];
  })) as DeepHealth["processes"];
  const ok = postgres.ok && valkey.ok && Object.values(processes).every((p) => p.ok);
  return { ok, checkedAt: new Date(t).toISOString(), postgres, valkey, processes };
}
