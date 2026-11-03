/**
 * Devices: one row per account and install id (the x-install-id header), with the push token once the person
 * allowed push and the OS's permission state either way. A token lives on one row only: registering it here
 * takes it off any other (the same phone signed in to another account, or reinstalled).
 */
import { and, eq, ne, or } from "drizzle-orm";
import type { DeviceRegister } from "@contestly/shared";
import { db, type Tx } from "../client.js";
import { deviceTokens, users, type DeviceToken } from "../schema.js";

type Conn = Tx | typeof db;

export async function registerDevice(userId: string, installId: string, body: DeviceRegister, now = new Date()): Promise<DeviceToken> {
  return db.transaction(async (tx) => {
    if (body.token) {
      await tx.update(deviceTokens).set({ token: null })
        .where(and(eq(deviceTokens.token, body.token), or(ne(deviceTokens.userId, userId), ne(deviceTokens.installId, installId))));
    }
    const values = { platform: body.platform, token: body.token, appVersion: body.appVersion, permission: body.permission, lastSeenAt: now };
    const [row] = await tx.insert(deviceTokens).values({ userId, installId, ...values })
      .onConflictDoUpdate({ target: [deviceTokens.userId, deviceTokens.installId], set: values }).returning();
    if (body.timeZone) await tx.update(users).set({ timeZone: body.timeZone }).where(eq(users.id, userId));
    return row;
  });
}

/** This install stops getting pushes for this account (sign-out, or the app turning push off). */
export async function unregisterDevice(userId: string, installId: string): Promise<boolean> {
  const rows = await db.delete(deviceTokens).where(and(eq(deviceTokens.userId, userId), eq(deviceTokens.installId, installId))).returning({ id: deviceTokens.id });
  return rows.length > 0;
}

/** Every device of the account (account deletion). */
export async function removeDevicesOf(conn: Conn, userId: string): Promise<number> {
  const rows = await conn.delete(deviceTokens).where(eq(deviceTokens.userId, userId)).returning({ id: deviceTokens.id });
  return rows.length;
}

export const deviceView = (d: DeviceToken) => ({
  installId: d.installId, platform: d.platform, hasToken: d.token !== null, appVersion: d.appVersion, permission: d.permission, lastSeenAt: d.lastSeenAt.toISOString(),
});
