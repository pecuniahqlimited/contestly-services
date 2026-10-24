/**
 * The base for every Colyseus room. A room's error must never take down the process (one process hosts
 * many rooms): every message handler, timer and fire-and-forget task goes through here, so a throw or a
 * rejected promise is logged with the room and what it was doing, the client that sent the message gets
 * MSG.error, and the room carries on. Rooms use handle(), after(), every() and run(), never the raw
 * onMessage / clock / `void promise` forms.
 */
import colyseus from "colyseus";
import type { Client, Delayed } from "colyseus";
import { ADMIN_EVENTS_CHANNEL, ACCOUNT_BANNED, MSG, type AdminEvent } from "@contestly/shared";
const { Room } = colyseus;

/** What a client is told when its message failed on the server. Never the error itself. */
export const SERVER_ERROR = "server_error";
/** WebSocket close code for a client removed because its account was banned. */
export const BANNED_CLOSE_CODE = 4403;

export abstract class SafeRoom extends Room {
  /** Names the room in logs, e.g. "party 3f…". */
  protected abstract get label(): string;

  /** The user id a client plays as (rooms keep it on client.auth). */
  protected userIdOf(client: Client): string | undefined {
    return (client.auth as { id?: string } | undefined)?.id;
  }

  /**
   * Admin events every room obeys: a banned user is removed at once (they can't rejoin; onAuth refuses).
   * Call from onCreate. RedisPresence hands callbacks parsed JSON, LocalPresence the raw string.
   */
  protected listenForAdminEvents() {
    this.presence.subscribe(ADMIN_EVENTS_CHANNEL, (raw: unknown) => this.run("admin event", () => {
      const ev = (typeof raw === "string" ? JSON.parse(raw) : raw) as AdminEvent;
      if (ev.kind !== "user_banned") return;
      for (const client of [...this.clients]) {
        if (this.userIdOf(client) !== ev.userId) continue;
        // Before the leave: onLeave must not hold the seat open (a reconnection token skips onAuth).
        this.removed.add(ev.userId);
        client.send(MSG.error, { error: ACCOUNT_BANNED });
        client.leave(BANNED_CLOSE_CODE);
      }
    }));
  }

  /** Users removed from this room (banned): never let back in by reconnection. */
  protected readonly removed = new Set<string>();

  /** A message handler, sync or async. */
  protected handle<T = unknown>(type: string, fn: (client: Client, data: T) => unknown) {
    this.onMessage(type, (client: Client, data: T) => this.run(`message ${type}`, () => fn(client, data), client));
  }

  /** Run work now without awaiting it. A throw or rejection is reported, never unhandled. */
  protected run(where: string, fn: () => unknown, client?: Client): void {
    try {
      const result = fn();
      if (result instanceof Promise) result.catch((err) => this.report(where, err, client));
    } catch (err) {
      this.report(where, err, client);
    }
  }

  /** Await work and report a failure instead of rejecting (for lifecycle hooks Colyseus awaits, like onLeave). */
  protected async guarded(where: string, fn: () => unknown, client?: Client): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.report(where, err, client);
    }
  }

  /** Hold a dropped client's seat; true if they came back in time, false once the grace runs out. */
  protected reconnected(client: Client, seconds: number): Promise<boolean> {
    // Rejects only when the grace runs out (Colyseus Deferred: then() takes one callback).
    return this.allowReconnection(client, seconds).then(() => true).catch(() => false);
  }

  /** A guarded timer on the room's clock (cleared when the room is disposed). */
  protected after(ms: number, where: string, fn: () => unknown): Delayed {
    return this.clock.setTimeout(() => this.run(where, fn), ms);
  }

  protected every(ms: number, where: string, fn: () => unknown): Delayed {
    return this.clock.setInterval(() => this.run(where, fn), ms);
  }

  /** Log it, tell the client whose message it was, and let subclasses react (e.g. end a round). */
  protected report(where: string, err: unknown, client?: Client): void {
    console.error(`[${this.label}] ${where} failed:`, err);
    if (client) client.send(MSG.error, { error: SERVER_ERROR });
    this.onRoomError(where, err);
  }

  /** Override to recover from a failure (default: nothing beyond the log). */
  protected onRoomError(_where: string, _err: unknown): void {}
}
