/**
 * Per-connection message cap, in memory (one counter per WebSocket, gone with it). Each second may carry
 * up to `perSecond` messages; past that they're dropped. A connection that stays over the cap for
 * `disconnectAfterSeconds` in a row (every second over, no quiet second between) is disconnected. A second
 * under the cap ends the burst. Separate from HTTP limits and from chat's per-user limits (chatRate.ts).
 */
export interface MessageCapConfig { perSecond: number; disconnectAfterSeconds: number }

const int = (raw: string | undefined, fallback: number, name: string) => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer (got "${raw}")`);
  return n;
};

/** ROOM_MESSAGES_PER_SECOND (default 20) and ROOM_FLOOD_DISCONNECT_SECONDS (default 5). */
export const messageCapFromEnv = (env = process.env): MessageCapConfig => ({
  perSecond: int(env.ROOM_MESSAGES_PER_SECOND, 20, "ROOM_MESSAGES_PER_SECOND"),
  disconnectAfterSeconds: int(env.ROOM_FLOOD_DISCONNECT_SECONDS, 5, "ROOM_FLOOD_DISCONNECT_SECONDS"),
});

/** ok: handle it. drop: over the cap (`firstInBurst` once per burst, for one log line). disconnect: over too long. */
export type CapVerdict = { kind: "ok" } | { kind: "drop"; firstInBurst: boolean } | { kind: "disconnect"; overForMs: number };

export class MessageCap {
  private windowStart = -Infinity;
  private count = 0;
  /** When the current run of over-the-cap seconds began; null when not in a burst. */
  private overSince: number | null = null;
  private windowOver = false;

  constructor(private readonly cfg: MessageCapConfig) {}

  check(now: number): CapVerdict {
    if (now - this.windowStart >= 1000) {
      // A new second. If the last one wasn't over (or was more than a second ago), the burst is over.
      const lastWasOver = this.windowOver && now - this.windowStart < 2000;
      if (!lastWasOver) this.overSince = null;
      this.windowStart = now;
      this.count = 0;
      this.windowOver = false;
    }
    this.count++;
    if (this.count <= this.cfg.perSecond) return { kind: "ok" };
    this.windowOver = true;
    const firstInBurst = this.overSince === null;
    if (firstInBurst) this.overSince = now;
    const overForMs = now - this.overSince!;
    if (overForMs >= this.cfg.disconnectAfterSeconds * 1000) return { kind: "disconnect", overForMs };
    return { kind: "drop", firstInBurst };
  }
}
