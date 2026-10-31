/**
 * A room's error must never take down the process. A test room built on SafeRoom throws from a sync
 * handler, an async handler and a timer; each is reported (the sender gets MSG.error), the room keeps
 * answering, and a second room in the same process is untouched. Vitest fails the run on any unhandled
 * rejection or uncaught exception, so passing means none escaped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import colyseus from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, type Room as ClientRoom } from "colyseus.js";
import { MSG, ROOM_FLOOD_CLOSE_CODE, TOO_MANY_MESSAGES } from "@contestly/shared";
import { SERVER_ERROR, SafeRoom } from "../src/SafeRoom.js";

const { Server } = colyseus;
const PORT = 4590 + Math.floor(Math.random() * 300);

class BoomRoom extends SafeRoom {
  protected get label() {
    return "boom";
  }
  onCreate() {
    this.handle("sync", () => {
      throw new Error("sync boom");
    });
    this.handle("async", async () => {
      await Promise.resolve();
      throw new Error("async boom");
    });
    this.handle("timer", () => {
      this.after(5, "timer", () => {
        throw new Error("timer boom");
      });
    });
    this.handle("asyncTimer", () => {
      this.after(5, "async timer", async () => {
        throw new Error("async timer boom");
      });
    });
    this.handle("echo", (client, data) => client.send("echo", data));
  }
  protected onRoomError(where: string) {
    this.broadcast("roomError", where);
  }
}

/** A room with a small per-connection cap: 5 messages a second, disconnected after 1 second over. */
class CappedRoom extends SafeRoom {
  protected readonly messageCap = { perSecond: 5, disconnectAfterSeconds: 1 };
  private handled = 0;
  protected get label() {
    return "capped";
  }
  onCreate() {
    this.handle("tick", () => void this.handled++);
    this.handle("count", (client) => client.send("count", this.handled));
  }
}

/** The next message of this type; the listener goes once it has fired, so it can't catch a later test's message. */
const next = <T>(room: ClientRoom, type: string) => new Promise<T>((resolve) => {
  const off = room.onMessage(type, (m: T) => {
    off();
    resolve(m);
  });
});

let server: InstanceType<typeof Server>;
let a: ClientRoom, b: ClientRoom;
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {}); // the failures are expected; keep the output clean
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  server = new Server({ transport: new WebSocketTransport() });
  server.define("boom", BoomRoom);
  server.define("capped", CappedRoom);
  await server.listen(PORT);
  const client = new Client(`ws://localhost:${PORT}`);
  a = await client.create("boom");
  b = await client.create("boom");
  for (const r of [a, b]) for (const t of [MSG.error, "roomError", "echo"]) r.onMessage(t, () => {});
});

afterAll(async () => {
  await a?.leave();
  await b?.leave();
  await server?.gracefullyShutdown(false);
});

describe("SafeRoom", () => {
  it("reports a sync throw in a handler to the sender, and the room carries on", async () => {
    const err = next<{ error: string }>(a, MSG.error);
    const reported = next<string>(a, "roomError");
    a.send("sync");
    expect((await err).error).toBe(SERVER_ERROR);
    expect(await reported).toBe("message sync");
    const echo = next(a, "echo");
    a.send("echo", { n: 1 });
    expect(await echo).toEqual({ n: 1 });
  });

  it("reports a rejected async handler", async () => {
    const err = next<{ error: string }>(a, MSG.error);
    const reported = next<string>(a, "roomError"); // sent after MSG.error: wait for it, or the timer test below catches it
    a.send("async");
    expect((await err).error).toBe(SERVER_ERROR);
    expect(await reported).toBe("message async");
  });

  it("reports throws and rejections in timers through onRoomError", async () => {
    const sync = next<string>(a, "roomError");
    a.send("timer");
    expect(await sync).toBe("timer");
    const rejected = next<string>(a, "roomError");
    a.send("asyncTimer");
    expect(await rejected).toBe("async timer");
  });

  it("leaves every other room in the process alone", async () => {
    a.send("sync");
    const echo = next(b, "echo");
    b.send("echo", "still here");
    expect(await echo).toBe("still here");
  });
});

describe("the per-connection message cap", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("drops what's over the cap in a second, logs once for the burst, and keeps the connection", async () => {
    const room = await new Client(`ws://localhost:${PORT}`).create("capped");
    room.onMessage(MSG.error, () => {});
    warn.mockClear();
    for (let i = 0; i < 20; i++) room.send("tick");
    await sleep(1100); // the next second: the count question itself is allowed
    const count = next<number>(room, "count");
    room.send("count");
    expect(await count).toBe(5);
    expect(warn.mock.calls.filter(([m]) => String(m).includes("dropping until it slows"))).toHaveLength(1);
    await room.leave();
  });

  it("disconnects a connection that stays over, and leaves the others alone", async () => {
    const flooder = await new Client(`ws://localhost:${PORT}`).create("capped");
    const calm = await new Client(`ws://localhost:${PORT}`).joinById(flooder.roomId);
    let error: string | undefined;
    flooder.onMessage(MSG.error, (m: { error: string }) => { error = m.error; });
    const closed = new Promise<number>((resolve) => flooder.onLeave((code) => resolve(code)));
    calm.onMessage("count", () => {});
    const flood = setInterval(() => { for (let i = 0; i < 10; i++) flooder.send("tick"); }, 100);
    const code = await closed;
    clearInterval(flood);
    expect([code, error]).toEqual([ROOM_FLOOD_CLOSE_CODE, TOO_MANY_MESSAGES]);
    const count = next<number>(calm, "count");
    calm.send("count");
    expect(typeof (await count)).toBe("number"); // still served
    await calm.leave();
  });
});
