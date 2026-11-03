/**
 * The soft signals corners' anti-farming reads (ADR 0012): the install id the app sends on every request
 * (INSTALL_ID_HEADER; made once per install, so a web build that loses its storage looks like a new device)
 * and the client IP. Each (account, signal) is written once; this process remembers what it has written so
 * a session's requests don't each touch the database.
 */
import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db, recordSignals, users } from "@contestly/db";
import { INSTALL_ID_HEADER, installIdSchema } from "@contestly/shared";

/** How many (account, install, IP) triples this process remembers before it starts again. */
const REMEMBERED = 50_000;
let written = new Set<string>();

/** The request's install id, if it sent a well-formed one. */
export const installIdOf = (req: FastifyRequest): string | null => {
  const raw = req.headers[INSTALL_ID_HEADER];
  const parsed = installIdSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  return parsed.success ? parsed.data : null;
};

export async function noteSignals(req: FastifyRequest): Promise<void> {
  const user = req.auth?.user;
  if (!user || user.isSystem) return;
  const installId = installIdOf(req);
  const key = `${user.id}|${installId ?? ""}|${req.clientIp}`;
  if (written.has(key)) return;
  await recordSignals(user.id, { installId, ip: req.clientIp });
  if (written.size >= REMEMBERED) written = new Set();
  written.add(key);
}

/** How stale users.last_seen_at may get: win-back counts whole days from it, so a few minutes is plenty. */
const SEEN_EVERY_MS = 5 * 60_000;
let seenAt = new Map<string, number>();

/** A session's request: the account was seen (win-back nudges count days without one). At most every few minutes per account. */
export async function noteSeen(req: FastifyRequest, now = Date.now()): Promise<void> {
  const user = req.auth?.user;
  if (!user || user.isSystem || now - (seenAt.get(user.id) ?? 0) < SEEN_EVERY_MS) return;
  if (seenAt.size >= REMEMBERED) seenAt = new Map();
  seenAt.set(user.id, now);
  await db.update(users).set({ lastSeenAt: new Date(now) }).where(eq(users.id, user.id));
}
