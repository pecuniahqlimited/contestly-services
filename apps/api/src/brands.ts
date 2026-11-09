/** Brands as the API shows them (ADR 0017): to anyone, to the team, and in the admin console. */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { checklistFor, corners, db, type Brand, type BrandMember, type User } from "@contestly/db";
import type { BrandChecklist, BrandRole, PublicBrand } from "@contestly/shared";

export const personView = (u: Pick<User, "id" | "handle" | "displayName" | "avatarEmoji" | "isVerified">) =>
  ({ id: u.id, handle: u.handle, displayName: u.displayName, avatarEmoji: u.avatarEmoji, isVerified: u.isVerified });

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/** The brands' corners shown publicly (unlocked, not archived): a brand gets one on approval. */
export async function cornerIdsOf(brandIds: string[]): Promise<Map<string, string>> {
  if (!brandIds.length) return new Map();
  const rows = await db.select({ id: corners.id, owner: corners.ownerUserId }).from(corners)
    .where(and(inArray(corners.ownerUserId, brandIds), eq(corners.status, "unlocked"), isNull(corners.archivedAt)));
  return new Map(rows.map((r) => [r.owner, r.id]));
}

export function publicBrandView(account: User, brand: Brand, cornerId: string | null): PublicBrand {
  return {
    id: account.id, handle: account.handle, displayName: account.displayName, avatarEmoji: account.avatarEmoji, logoUrl: brand.logoUrl, bio: account.bio,
    lane: brand.lane ?? null, siteUrl: brand.siteUrl, socials: brand.socials ?? {}, isVerified: account.isVerified && brand.verificationStatus === "verified", cornerId,
  };
}

export const verificationView = (b: Brand) => ({ status: b.verificationStatus, note: b.verificationNote, submittedAt: iso(b.submittedAt), decidedAt: iso(b.decidedAt) });

/** What the team sees in settings: the public brand, its private fields, the checklist and their role. */
export async function settingsView(account: User, brand: Brand, role: BrandRole, checklist?: BrandChecklist) {
  const cornerId = (await cornerIdsOf([account.id])).get(account.id) ?? null;
  return {
    ...publicBrandView(account, brand, cornerId), role, registrationNumber: brand.registrationNumber, businessEmail: brand.businessEmail,
    businessEmailVerifiedAt: iso(brand.businessEmailVerifiedAt), cashPrizes: brand.cashPrizes, hostSpendLimitKobo: brand.hostSpendLimitKobo, verification: verificationView(brand), checklist: checklist ?? (await checklistFor(db, brand)),
  };
}

export const memberView = (m: { u: User; role: BrandMember["role"]; joinedAt: Date }) => ({ ...personView(m.u), role: m.role, joinedAt: m.joinedAt.toISOString() });

type InviteRow = { id: string; role: BrandMember["role"]; status: string; invitedByUserId: string; inviteeUserId: string | null; email: string | null; createdAt: Date };
export function inviteView(i: InviteRow, people: Map<string, User>) {
  const invitee = i.inviteeUserId ? people.get(i.inviteeUserId) : undefined;
  return {
    id: i.id, role: i.role as "admin" | "host" | "viewer", status: i.status as "pending", invitedBy: personView(people.get(i.invitedByUserId)!),
    to: invitee ? { person: personView(invitee) } : { email: i.email ?? "" }, createdAt: i.createdAt.toISOString(),
  };
}
