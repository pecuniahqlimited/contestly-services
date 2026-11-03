/**
 * DEV ONLY: DEV_ADMIN_HANDLES (comma-separated, default tunde) are admins holding every payments permission,
 * so the local console works end to end. Idempotent: run by db:seed, and alone by `npm run db:dev-admins` on a
 * database that wasn't reseeded. Refused in production (NODE_ENV=production): real admins come from
 * ADMIN_EMAILS and are granted permissions one by one, by two admins (ADR 0013).
 */
import { inArray } from "drizzle-orm";
import { PAYMENT_PERMISSIONS } from "@contestly/shared";
import type { Tx } from "./client.js";
import { adminPermissions, users } from "./schema.js";
import { recordAdminAction, systemActorId } from "./admin.js";

export const devAdminHandles = (env: NodeJS.ProcessEnv = process.env) =>
  (env.DEV_ADMIN_HANDLES ?? "tunde").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

/** Returns each dev admin found and the permissions it newly got (logged as the system). Handles with no account are skipped. */
export async function grantDevAdmins(tx: Tx, handles: string[], env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === "production") throw new Error("dev admins are never granted in production");
  if (!handles.length) return [];
  const admins = await tx.update(users).set({ isAdmin: true }).where(inArray(users.handle, handles)).returning({ id: users.id, handle: users.handle });
  const out: { handle: string; granted: string[] }[] = [];
  for (const a of admins) {
    const added = await tx.insert(adminPermissions).values(PAYMENT_PERMISSIONS.map((permission) => ({ userId: a.id, permission }))).onConflictDoNothing()
      .returning({ permission: adminPermissions.permission });
    const granted = added.map((r) => r.permission).sort();
    if (granted.length) {
      await recordAdminAction(tx, { adminUserId: await systemActorId(tx), action: "payments.dev_admin_grant", targetType: "user", targetId: a.id, reason: "DEV_ADMIN_HANDLES (dev only)", before: null, after: granted });
    }
    out.push({ handle: a.handle, granted });
  }
  return out;
}
