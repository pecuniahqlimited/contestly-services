/**
 * One room per key, however many arrive at once (roomClaims.ts). The load test found parties split into up to
 * 20 rooms: Colyseus waits at most 500 ms for a room another join is creating, and a party room's setup reads
 * the database. Here a room's setup takes longer than that on purpose and a crowd joins together; every client
 * must land in the same room, and once it's gone the key is free for a new one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import colyseus from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { SafeRoom } from "../src/SafeRoom.js";
import { memoryClaims, useRoomClaims } from "../src/roomClaims.js";

const { Server } = colyseus;
const PORT = 4890 + Math.floor(Math.random() * 300);
/** Longer than Colyseus's 500 ms wait for a room being created: without the claim, the crowd splits. */
const SETUP_MS = 1_500;
const CROWD = 20;

class SlowRoom extends SafeRoom {
  private key = "";
  protected get label() {
    return `slow ${this.key}`;
  }
  async onCreate(options: { key: string }) {
    this.key = options.key;
    if (!(await this.soleRoomFor(`slow:${options.key}`))) return;
    await new Promise((r) => setTimeout(r, SETUP_MS));
  }
  onDispose() {
    if (this.standIn) return;
    this.run("room claim: release", () => this.releaseSoleRoom());
  }
}

let server: InstanceType<typeof Server>;
const url = `ws://localhost:${PORT}`;

beforeAll(async () => {
  useRoomClaims(memoryClaims());
  server = new Server({ transport: new WebSocketTransport() });
  server.define("slow", SlowRoom).filterBy(["key"]);
  await server.listen(PORT);
});
afterAll(async () => {
  await server.gracefullyShutdown(false);
});

describe("one room per key", () => {
  it("puts a crowd arriving together in one room", async () => {
    const rooms = await Promise.all(Array.from({ length: CROWD }, () => new Client(url).joinOrCreate("slow", { key: "a" })));
    expect(new Set(rooms.map((r) => r.roomId)).size).toBe(1);
    // A different key is a different room.
    const other = await new Client(url).joinOrCreate("slow", { key: "b" });
    expect(other.roomId).not.toBe(rooms[0].roomId);
    await Promise.all([...rooms, other].map((r) => r.leave()));
  }, 40_000);

  it("frees the key when its room is gone, so the next join makes a new one", async () => {
    const first = await new Client(url).joinOrCreate("slow", { key: "c" });
    const firstId = first.roomId;
    await first.leave();
    // The empty room disposes and releases its claim.
    await new Promise((r) => setTimeout(r, 300));
    const again = await new Client(url).joinOrCreate("slow", { key: "c" });
    expect(again.roomId).not.toBe(firstId);
    await again.leave();
  }, 20_000);
});
