import { createServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { eq } from "drizzle-orm";
import { db, parties, chatMessages } from "@contestly/db";
import { resolveUser } from "@contestly/auth";
import { makeRedis } from "@contestly/queue";
import { RT, PARTY_EVENTS_CHANNEL, chatSendSchema } from "@contestly/shared";

const http = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, service: "realtime" })); });
const io = new Server(http, {
  cors: { origin: (process.env.WEB_ORIGIN ?? "http://localhost:5173").split(","), credentials: true },
  // Cloudflare drops idle WebSockets at ~100s; keep pings well under that.
  pingInterval: 25_000, pingTimeout: 20_000,
});

// Redis adapter: lets several realtime instances share rooms later with zero code changes.
const pub = makeRedis(); const sub = makeRedis();
io.adapter(createAdapter(pub, sub));

// Worker → realtime: party lifecycle events.
const events = makeRedis();
await events.subscribe(PARTY_EVENTS_CHANNEL);
events.on("message", (_ch: string, raw: string) => { const ev = JSON.parse(raw) as { partyId: string; status: string }; io.to(room(ev.partyId)).emit(RT.partyStatus, ev); });

const room = (partyId: string) => `party:${partyId}`;
type Member = { id: string; handle: string; displayName: string; avatarEmoji: string };

io.use(async (socket, next) => {
  try {
    const { user } = await resolveUser({ authorization: socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : socket.handshake.headers.authorization, devUser: (socket.handshake.auth?.devUser as string) ?? (socket.handshake.headers["x-dev-user"] as string) });
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = { id: user.id, handle: user.handle, displayName: user.displayName, avatarEmoji: user.avatarEmoji } satisfies Member;
    next();
  } catch (e) { next(e as Error); }
});

async function presence(partyId: string) {
  const sockets = await io.in(room(partyId)).fetchSockets();
  const seen = new Map<string, Member>();
  for (const s of sockets) seen.set(s.data.user.id, s.data.user);
  io.to(room(partyId)).emit(RT.presence, { partyId, online: [...seen.values()] });
}

io.on("connection", (socket) => {
  const me: Member = socket.data.user;

  socket.on(RT.lobbyJoin, async ({ partyId }: { partyId: string }) => {
    const [p] = await db.select({ id: parties.id, status: parties.status }).from(parties).where(eq(parties.id, partyId));
    if (!p) return socket.emit(RT.error, { error: "not_found" });
    await socket.join(room(partyId));
    socket.emit(RT.partyStatus, { partyId, status: p.status });
    await presence(partyId);
  });

  socket.on(RT.lobbyLeave, async ({ partyId }: { partyId: string }) => { await socket.leave(room(partyId)); await presence(partyId); });

  socket.on(RT.chatSend, async (raw: unknown) => {
    const parsed = chatSendSchema.safeParse(raw);
    if (!parsed.success) return socket.emit(RT.error, { error: "validation", issues: parsed.error.issues });
    const m = parsed.data;
    if (!socket.rooms.has(room(m.partyId))) return socket.emit(RT.error, { error: "join_lobby_first" });
    const [saved] = await db.insert(chatMessages).values({ partyId: m.partyId, userId: me.id, text: m.text, sticker: m.sticker }).returning();
    io.to(room(m.partyId)).emit(RT.chatMessage, { ...saved, handle: me.handle, avatarEmoji: me.avatarEmoji, displayName: me.displayName });
  });

  socket.on("disconnecting", () => { for (const r of socket.rooms) if (r.startsWith("party:")) setTimeout(() => presence(r.slice(6)), 50); });
});

const port = Number(process.env.REALTIME_PORT ?? 4001);
http.listen(port, "0.0.0.0", () => console.log(`realtime listening on :${port}`));
