/** Shared admin read helpers: people, the action log, and the user row the console lists. */
import { adminActionsFor, type User } from "@contestly/db";
import { adminActionSchema, type AdminAction, type AdminUserRow } from "@contestly/shared";
import { toPerson } from "./people.js";

/** A deleted account lists by what it was (the archive), so admins recognise it; shown as Deleted by deletedAt. */
export const adminUserRow = (u: User): AdminUserRow => ({
  id: u.id,
  handle: u.deletedAt ? (u.archivedHandle ?? u.handle) : u.handle,
  displayName: u.deletedAt ? (u.archivedDisplayName ?? u.displayName) : u.displayName,
  avatarEmoji: u.deletedAt ? (u.archivedAvatarEmoji ?? u.avatarEmoji) : u.avatarEmoji,
  email: u.deletedAt ? u.archivedEmail : u.email,
  isGuest: u.isGuest, isAdmin: u.isAdmin, isBrand: u.isBrand, bannedAt: u.bannedAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString(),
  deletedAt: u.deletedAt?.toISOString() ?? null,
});

export async function actionsView(filter: { targetType?: string; targetId?: string; limit?: number }): Promise<AdminAction[]> {
  const rows = await adminActionsFor({ ...filter, limit: filter.limit ?? 50 });
  return rows.map(({ a, admin }) => adminActionSchema.parse({
    id: a.id, admin: toPerson(admin), action: a.action, targetType: a.targetType, targetId: a.targetId,
    reason: a.reason, before: a.before, after: a.after, createdAt: a.createdAt.toISOString(),
  }));
}
