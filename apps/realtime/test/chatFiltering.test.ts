/**
 * Chat filtered per recipient, on the server (ADR 0014): a room delivers each line only to the clients allowed to
 * see it. Real Colyseus clients in one room; who's hidden from whom comes from a fake loader standing in for the
 * blocks and mutes in Postgres (the integration tests cover that query).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import colyseus from "colyseus";
import type { Client as ServerClient } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, type Room as ClientRoom } from "colyseus.js";
import { MSG, type ChatMessage } from "@contestly/shared";
import { SafeRoom } from "../src/SafeRoom.js";
import { HiddenAuthors } from "../src/hiddenAuthors.js";

const { Server } = colyseus;
const PORT = 4900 + Math.floor(Math.random() * 300);

/** kemi blocked ada (so each is hidden from the other); zee muted tunde. */
const HIDES: Record<string, string[]> = { ada: ["kemi"], kemi: ["ada"], zee: ["tunde"] };

class ChatRoom extends SafeRoom {
  protected readonly hidden = new HiddenAuthors(async (id) => new Set(HIDES[id] ?? []));
  /** A card's flag from each recipient's side, standing in for the challenge rows (the integration tests cover those). */
  protected readonly asSeenBy = async (l: ChatMessage, viewerId: string | undefined) =>
    l.kind === "party_card" ? { ...l, challenge: { state: viewerId === "kemi" ? "declined" as const : "pending" as const, cardUrl: `/challenges/${l.partyId}` } } : l;
  protected get label() { return "chat"; }
  onAuth(_c: ServerClient, options: { userId: string }) { return { id: options.userId }; }
  onCreate() {
    this.handle("say", (client, text: string) => this.deliverLine(this.clients, line(this.userIdOf(client)!, text)));
    this.handle("system", (_c, text: string) => this.deliverLine(this.clients, { ...line("x", text), author: null }));
    this.handle("card", (_c, partyId: string) => this.deliverLine(this.clients, { ...line("x", "a challenge"), kind: "party_card", partyId, author: null }));
  }
}

const line = (author: string, text: string): ChatMessage => ({
  id: crypto.randomUUID(), threadId: crypto.randomUUID(), kind: "text", text, sticker: null, mentions: [], voice: null, partyId: null, challenge: null, clientMsgId: null,
  createdAt: new Date().toISOString(), author: { id: author, handle: author, displayName: author, avatarEmoji: "😎", isVerified: false },
});

let server: InstanceType<typeof Server>;
const rooms: Record<string, ClientRoom> = {};
const heard: Record<string, string[]> = {};
const cards: Record<string, ChatMessage["challenge"][]> = {};
const settle = () => new Promise((r) => setTimeout(r, 150));

beforeAll(async () => {
  server = new Server({ transport: new WebSocketTransport() });
  server.define("chat", ChatRoom);
  await server.listen(PORT);
  const first = await new Client(`ws://localhost:${PORT}`).joinOrCreate("chat", { userId: "ada" });
  rooms.ada = first;
  for (const id of ["kemi", "zee", "tunde"]) rooms[id] = await new Client(`ws://localhost:${PORT}`).joinById(first.roomId, { userId: id });
  for (const [id, r] of Object.entries(rooms)) {
    heard[id] = [];
    cards[id] = [];
    r.onMessage(MSG.chatMessage, (m: ChatMessage) => (m.kind === "party_card" ? cards[id].push(m.challenge) : heard[id].push(m.text!)));
    r.onMessage(MSG.error, () => {});
  }
});

afterAll(async () => {
  for (const r of Object.values(rooms)) await r.leave();
  await server?.gracefullyShutdown(false);
});

describe("a shared party's chat", () => {
  it("never reaches someone blocked either way with the writer", async () => {
    rooms.kemi.send("say", "kemi here");
    rooms.ada.send("say", "ada here");
    await settle();
    expect(heard.ada).toEqual(["ada here"]);
    expect(heard.kemi).toEqual(["kemi here"]);
    expect(heard.zee.sort()).toEqual(["ada here", "kemi here"]);
    expect(heard.tunde.sort()).toEqual(["ada here", "kemi here"]);
  });

  it("hides a muted person's lines from the muter only", async () => {
    for (const id of Object.keys(heard)) heard[id] = [];
    rooms.tunde.send("say", "tunde here");
    await settle();
    expect(heard.zee).toEqual([]);
    expect(heard.ada).toEqual(["tunde here"]);
    expect(heard.tunde).toEqual(["tunde here"]);
  });

  it("delivers system lines to everyone", async () => {
    for (const id of Object.keys(heard)) heard[id] = [];
    rooms.ada.send("system", "the party is live");
    await settle();
    for (const id of Object.keys(heard)) expect(heard[id]).toEqual(["the party is live"]);
  });

  it("a challenge's card reaches each recipient with its state from their side", async () => {
    const partyId = crypto.randomUUID();
    rooms.ada.send("card", partyId);
    await settle();
    expect(cards.kemi).toEqual([{ state: "declined", cardUrl: `/challenges/${partyId}` }]);
    for (const id of ["ada", "zee", "tunde"]) expect(cards[id]).toEqual([{ state: "pending", cardUrl: `/challenges/${partyId}` }]);
  });
});
