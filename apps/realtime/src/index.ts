/**
 * Colyseus game server. Rooms live in this process; Valkey (RedisPresence + RedisDriver) holds
 * presence, room discovery and pub/sub, so a second instance is config, not code. filterBy
 * partyId means joinOrCreate lands every player of a party in the same room.
 */
import { createServer } from "node:http";
// colyseus ships CJS with star re-exports Node's ESM lexer can't see; destructure the default.
import colyseus, { RedisPresence, RedisDriver } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
const { Server } = colyseus;
import { PARTY_ROOM } from "@contestly/shared";
import { PartyRoom } from "./PartyRoom.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const http = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "realtime" }));
});

const gameServer = new Server({
  // Cloudflare drops idle WebSockets at ~100s; Colyseus pings every few seconds by default, well under that.
  transport: new WebSocketTransport({ server: http }),
  presence: new RedisPresence(REDIS_URL),
  driver: new RedisDriver(REDIS_URL),
});

gameServer.define(PARTY_ROOM, PartyRoom).filterBy(["partyId"]);

const port = Number(process.env.REALTIME_PORT ?? 4001);
await gameServer.listen(port);
console.log(`realtime (colyseus) listening on :${port}`);
