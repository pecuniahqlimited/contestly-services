/**
 * The base for every Colyseus room. A room's error must never take down the process (one process hosts
 * many rooms): every message handler, timer and fire-and-forget task goes through here, so a throw or a
 * rejected promise is logged with the room and what it was doing, the client that sent the message gets
 * MSG.error, and the room carries on. Rooms use handle(), after(), every() and run(), never the raw
 * onMessage / clock / `void promise` forms.
 */
import colyseus from "colyseus";
import type { Client, Delayed } from "colyseus";
import { MSG } from "@contestly/shared";
const { Room } = colyseus;

/** What a client is told when its message failed on the server. Never the error itself. */
export const SERVER_ERROR = "server_error";

export abstract class SafeRoom extends Room {
  /** Names the room in logs, e.g. "party 3f…". */
  protected abstract get label(): string;

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
