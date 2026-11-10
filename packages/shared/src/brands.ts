/**
 * Brands and teams (ADR 0017): a brand is an account people act as, never one anyone signs in as. The active
 * profile goes on each request as ACT_AS_HEADER; what each role may do is BRAND_ROLE_CAPABILITIES, the one table.
 */
import { z } from "zod";
import { CATEGORIES } from "./categories.js";
import { handleSchema } from "./accounts.js";
import { personSchema } from "./person.js";
import { reasonSchema } from "./admin.js";
import { imageKeySchema } from "./images.js";

// ---- acting as a brand -----------------------------------------------------------------

/** The active profile: a brand's id, sent per request. No header: the person themselves. */
export const ACT_AS_HEADER = "x-act-as";

/** 401: a session for a brand's account itself; nobody signs in as a brand, people act as one. */
export const BRAND_ACCOUNT_SESSION = "brand_account_session";
/** 400: this route can't be used as a brand (joining, the Climb, crews...). Send it without ACT_AS_HEADER. */
export const NOT_AVAILABLE_AS_BRAND = "not_available_as_brand";
/** 404: not on this brand's team (never says whether the brand exists). */
export const NOT_A_MEMBER = "not_a_member";
/** 400: something only a brand has (its logo) was asked for without acting as the brand (x-act-as). */
export const ACT_AS_BRAND_REQUIRED = "act_as_brand_required";
/** 403: on the team, but the role doesn't allow it. details: { capability, role }. */
export const BRAND_ROLE_FORBIDDEN = "brand_role_forbidden";
/** 422: an unverified brand hosts free parties only (entry 0, no prize). */
export const BRAND_NOT_VERIFIED = "brand_not_verified";
/**
 * 403: a member of the brand's team can't take a seat in one of its parties with a prize of any kind (entry, cash or
 * goods); its free parties are fine. Settlement checks it again, so joining the team after taking a seat wins nothing.
 */
export const BRAND_TEAM_MEMBER = "brand_team_member";
/** 404: no logo is waiting for review for this brand. */
export const NO_PENDING_LOGO = "no_pending_logo";
/** 409: the logo waiting isn't the one the decision names (the team sent another since). details: { pendingKey }. */
export const PENDING_LOGO_CHANGED = "pending_logo_changed";
/** A party with something to win: an entry (a pot), a host's cash prize, or goods. A free party has none. */
export const partyHasPrize = (p: { entryKobo: number; funding: string; prizeKind: string; hostPoolKobo: number }) =>
  p.entryKobo > 0 || (p.funding === "host" && (p.prizeKind !== "cash" || p.hostPoolKobo > 0));
/** 409: the owner can't leave or be removed; they hand over or delete the brand. */
export const OWNER_MUST_HAND_OVER = "owner_must_hand_over";

// ---- roles -----------------------------------------------------------------------------

export const BRAND_ROLES = ["owner", "admin", "host", "viewer"] as const;
export type BrandRole = (typeof BRAND_ROLES)[number];
/** What an invite or a role change can give: ownership moves only by hand-over. */
export const ASSIGNABLE_BRAND_ROLES = ["admin", "host", "viewer"] as const;
export type AssignableBrandRole = (typeof ASSIGNABLE_BRAND_ROLES)[number];

export const BRAND_CAPABILITIES = [
  "view", // the brand's settings, team, parties and prizes
  "inbox.read",
  "inbox.write", // DMs from the brand
  "parties.host", // create and run parties as the brand (isHostTeam)
  "prizes.fulfil", // mark goods arranged and delivered
  "team.manage", // invite, change roles, remove
  "settings", // profile, verification checklist, submit
  "wallet.view",
  "wallet.topup",
  "corner.post", // post on the brand's corner
  "corner.manage", // the brand's corner: its name and look, mutes, deleting posts and replies
  "wallet.withdraw",
  "payout_accounts",
  "ownership", // hand over
  "delete",
] as const;
export type BrandCapability = (typeof BRAND_CAPABILITIES)[number];

const VIEWER: readonly BrandCapability[] = ["view", "inbox.read"];
const HOST: readonly BrandCapability[] = [...VIEWER, "inbox.write", "parties.host", "prizes.fulfil", "corner.post"];
const ADMIN: readonly BrandCapability[] = [...HOST, "team.manage", "settings", "wallet.view", "wallet.topup", "corner.manage"];
const OWNER: readonly BrandCapability[] = [...ADMIN, "wallet.withdraw", "payout_accounts", "ownership", "delete"];

/** The one table of who may do what (ADR 0017 §3). */
export const BRAND_ROLE_CAPABILITIES: Record<BrandRole, readonly BrandCapability[]> = { owner: OWNER, admin: ADMIN, host: HOST, viewer: VIEWER };
export const brandRoleCan = (role: BrandRole, capability: BrandCapability) => BRAND_ROLE_CAPABILITIES[role].includes(capability);
/** The roles on a brand party's host team (isHostTeam): they can't play its curate parties. */
export const HOST_TEAM_ROLES = BRAND_ROLES.filter((r) => brandRoleCan(r, "parties.host"));

/** The highest host spending limit settings accept: the default party limits' biggest host prize (₦500,000). */
export const MAX_HOST_SPEND_LIMIT_KOBO = 50_000_000;

/** Team size, owner included, and open invites counted. */
export const BRAND_MAX_TEAM = 20;

// ---- the brand -------------------------------------------------------------------------

export const BRAND_VERIFICATION_STATUSES = ["draft", "in_review", "changes_needed", "verified"] as const;
export type BrandVerificationStatus = (typeof BRAND_VERIFICATION_STATUSES)[number];

/** A Corporate Affairs Commission number: RC (company), BN (business name) or IT (trustees), then digits. */
export const CAC_NUMBER_RE = /^(RC|BN|IT)\s?\d{4,8}$/i;
export const normaliseCac = (raw: string) => raw.trim().toUpperCase().replace(/\s+/g, "");

export const BRAND_SOCIALS = ["instagram", "x", "tiktok", "facebook", "linkedin", "youtube"] as const;
export type BrandSocial = (typeof BRAND_SOCIALS)[number];
const urlSchema = z.string().trim().url().max(200).refine((u) => /^https?:\/\//i.test(u), "an http(s) link");
const socialsSchema = z.record(z.enum(BRAND_SOCIALS), urlSchema);

const brandFields = {
  name: z.string().trim().min(2).max(40),
  logoEmoji: z.string().min(1).max(8),
  /** The uploaded logo's key (POST /images/uploads, purpose brand_logo, acting as the brand). Null: the emoji shows. */
  logoKey: imageKeySchema.nullable(),
  bio: z.string().trim().max(200).nullable(),
  lane: z.enum(CATEGORIES).nullable(),
  siteUrl: urlSchema.nullable(),
  socials: socialsSchema,
  registrationNumber: z.string().trim().max(20).refine((v) => CAC_NUMBER_RE.test(v), "a CAC number: RC, BN or IT and its digits").nullable(),
  /** Whether the brand will give cash prizes: then verification needs a payout account. */
  cashPrizes: z.boolean(),
  /**
   * The most a Host may put up from the brand's wallet as one party's cash prize (ADR 0017 §3). Set by the owner and
   * admins in settings; ₦0 by default (hosts run free and entry parties only); owners and admins fund up to the caps.
   */
  hostSpendLimitKobo: z.number().int().min(0).max(MAX_HOST_SPEND_LIMIT_KOBO),
};

/** POST /brands: the signed-in person makes a brand and is its owner. Everything but name and handle can come later. */
export const createBrandSchema = z.object({
  name: brandFields.name,
  handle: handleSchema,
  logoEmoji: brandFields.logoEmoji.default("🏷️"),
  bio: brandFields.bio.optional(),
  lane: brandFields.lane.optional(),
  siteUrl: brandFields.siteUrl.optional(),
  socials: brandFields.socials.optional(),
  registrationNumber: brandFields.registrationNumber.optional(),
  cashPrizes: brandFields.cashPrizes.default(false),
});
export type CreateBrandInput = z.infer<typeof createBrandSchema>;
/** PATCH /brands/:id (settings): any field; null clears an optional one. The handle can't change. */
export const updateBrandSchema = createBrandSchema.omit({ handle: true }).partial().extend({
  logoEmoji: brandFields.logoEmoji.optional(), logoKey: brandFields.logoKey.optional(), cashPrizes: brandFields.cashPrizes.optional(), hostSpendLimitKobo: brandFields.hostSpendLimitKobo.optional(),
});
export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;

/** A brand as anyone sees it (its profile, a party's host, search). */
export const publicBrandSchema = z.object({
  id: z.string().uuid(),
  handle: z.string(),
  displayName: z.string(),
  avatarEmoji: z.string(),
  /** The uploaded logo, as a read URL that works for IMAGE_READ_URL_SECONDS (fetch the brand again for a fresh one). Null: show the emoji. */
  logoUrl: z.string().nullable(),
  bio: z.string().nullable(),
  lane: z.enum(CATEGORIES).nullable(),
  siteUrl: z.string().nullable(),
  socials: z.record(z.string()),
  isVerified: z.boolean(),
  /** Its corner, once verified (ADR 0012 §4). */
  cornerId: z.string().uuid().nullable(),
});
export type PublicBrand = z.infer<typeof publicBrandSchema>;

/** What verification still needs; `complete` is when it can be submitted. */
export const brandChecklistSchema = z.object({
  registrationNumber: z.boolean(),
  logo: z.boolean(),
  link: z.boolean(),
  businessEmail: z.boolean(),
  /** Needed only when cashPrizes is on. */
  payoutAccount: z.enum(["done", "missing", "not_needed"]),
  complete: z.boolean(),
});
export type BrandChecklist = z.infer<typeof brandChecklistSchema>;

export const brandVerificationSchema = z.object({
  status: z.enum(BRAND_VERIFICATION_STATUSES),
  /** The reviewer's note when changes are needed. */
  note: z.string().nullable(),
  submittedAt: z.string().datetime().nullable(),
  decidedAt: z.string().datetime().nullable(),
});

/** A logo waiting for review: its key, a read URL (IMAGE_READ_URL_SECONDS) and when it was sent. */
export const pendingLogoSchema = z.object({ key: z.string(), url: z.string(), submittedAt: z.string().datetime() });

/** GET /brands/:id/settings (view and up): the brand, its private fields, the checklist and your role. */
export const brandSettingsSchema = publicBrandSchema.extend({
  role: z.enum(BRAND_ROLES),
  registrationNumber: z.string().nullable(),
  businessEmail: z.string().nullable(),
  businessEmailVerifiedAt: z.string().datetime().nullable(),
  cashPrizes: z.boolean(),
  hostSpendLimitKobo: z.number().int(),
  /** The logo's key, as attached (logoUrl reads it). */
  logoKey: z.string().nullable(),
  /** A verified brand's new logo, waiting for an admin; logoUrl stays the live one until it's approved. */
  pendingLogo: pendingLogoSchema.nullable(),
  /** The last logo an admin rejected, with their note; cleared when another is sent or one is approved. */
  logoRejection: z.object({ note: z.string(), rejectedAt: z.string().datetime() }).nullable(),
  verification: brandVerificationSchema,
  checklist: brandChecklistSchema,
});
export type BrandSettings = z.infer<typeof brandSettingsSchema>;

/** One of my brands (GET /me/brands): what the profile switcher lists. */
export const myBrandSchema = publicBrandSchema.extend({ role: z.enum(BRAND_ROLES), verificationStatus: z.enum(BRAND_VERIFICATION_STATUSES) });

// ---- the team --------------------------------------------------------------------------

export const brandMemberSchema = personSchema.extend({ role: z.enum(BRAND_ROLES), joinedAt: z.string().datetime() });
export type BrandMember = z.infer<typeof brandMemberSchema>;

/** POST /brands/:id/invites: by handle (on the app) or email (anyone; they land in the invite when they sign up). */
export const inviteBrandMemberSchema = z.union([
  z.object({ handle: z.string().trim().toLowerCase().min(3).max(20), role: z.enum(ASSIGNABLE_BRAND_ROLES) }),
  z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(ASSIGNABLE_BRAND_ROLES) }),
]);
export type InviteBrandMemberInput = z.infer<typeof inviteBrandMemberSchema>;

export const BRAND_INVITE_STATUSES = ["pending", "accepted", "declined", "revoked"] as const;
/** An invite as the team sees it: `to` is the person, or for an email nobody's claimed yet, the address. */
export const brandInviteSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(ASSIGNABLE_BRAND_ROLES),
  status: z.enum(BRAND_INVITE_STATUSES),
  invitedBy: personSchema,
  to: z.union([z.object({ person: personSchema }), z.object({ email: z.string() })]),
  createdAt: z.string().datetime(),
});
/** An invite as its invitee sees it (GET /me/brands: invites). */
export const myBrandInviteSchema = z.object({
  id: z.string().uuid(),
  brand: publicBrandSchema,
  role: z.enum(ASSIGNABLE_BRAND_ROLES),
  invitedBy: personSchema,
  createdAt: z.string().datetime(),
});
/** GET /me/brands: the brands I'm on and invites waiting for me. */
export const myBrandsResponseSchema = z.object({ brands: z.array(myBrandSchema), invites: z.array(myBrandInviteSchema) });
export type MyBrandsResponse = z.infer<typeof myBrandsResponseSchema>;
/** GET /brands/:id/team: members (owner first) and open invites. */
export const brandTeamResponseSchema = z.object({ members: z.array(brandMemberSchema), invites: z.array(brandInviteSchema) });

/** PATCH /brands/:id/members/:userId */
export const brandRoleChangeSchema = z.object({ role: z.enum(ASSIGNABLE_BRAND_ROLES) });
/** POST /brands/:id/owner: hand over to a member; the old owner becomes an admin. */
export const brandHandOverSchema = z.object({ userId: z.string().uuid() });

/** DELETE /brands/:id (the owner): an optional reason, kept on the archived account. */
export const deleteBrandSchema = z.object({ reason: z.string().trim().max(500).optional() });

/** POST /brands/:id/business-email/start { email } → a code to that address; /verify { email, code }. */
export const brandEmailStartSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
export const brandEmailVerifySchema = brandEmailStartSchema.extend({ code: z.string().regex(/^\d{6}$/) });

/** What brand_events records: every team change and verification step, append-only. */
export const BRAND_EVENT_KINDS = [
  "created", "invited", "invite_revoked", "invite_accepted", "invite_declined", "role_changed", "removed", "left", "handed_over",
  "settings_changed", "business_email_verified", "submitted", "approved", "changes_requested", "deleted",
  "logo_submitted", "logo_approved", "logo_rejected",
] as const;
export type BrandEventKind = (typeof BRAND_EVENT_KINDS)[number];

// ---- prize fulfilment ------------------------------------------------------------------

export const FULFILMENT_STATUSES = ["awarded", "arranged", "delivered", "disputed"] as const;
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number];
/** What may follow what: the brand moves a prize forward; the winner disputes one that's arranged or delivered. */
export const FULFILMENT_NEXT: Record<FulfilmentStatus, readonly FulfilmentStatus[]> = {
  awarded: ["arranged"],
  arranged: ["delivered", "disputed"],
  delivered: ["disputed"],
  disputed: ["arranged", "delivered"],
};
export const canMoveFulfilment = (from: FulfilmentStatus, to: FulfilmentStatus) => FULFILMENT_NEXT[from].includes(to);
/** Days after a prize is awarded when the brand and the winner hear about it again if it isn't delivered. */
export const FULFILMENT_NUDGE_DAYS = [3, 7] as const;

export const prizeFulfilmentSchema = z.object({
  id: z.string().uuid(),
  partyId: z.string().uuid(),
  partyTitle: z.string(),
  place: z.number().int(),
  prizeText: z.string(),
  prizeValueKobo: z.number().int().nullable(),
  status: z.enum(FULFILMENT_STATUSES),
  winner: personSchema,
  host: personSchema,
  /** The brand's note to the winner (how and when), and the winner's dispute note. */
  note: z.string().nullable(),
  disputeNote: z.string().nullable(),
  awardedAt: z.string().datetime(),
  arrangedAt: z.string().datetime().nullable(),
  deliveredAt: z.string().datetime().nullable(),
  disputedAt: z.string().datetime().nullable(),
});
export type PrizeFulfilment = z.infer<typeof prizeFulfilmentSchema>;
export const prizeFulfilmentsResponseSchema = z.object({ prizes: z.array(prizeFulfilmentSchema) });
/** POST /brands/:id/prizes/:fid { status: arranged | delivered, note? } */
export const fulfilmentUpdateSchema = z.object({ status: z.enum(["arranged", "delivered"]), note: z.string().trim().min(1).max(300).optional() });
/** POST /me/prizes/:fid/dispute { note } */
export const fulfilmentDisputeSchema = z.object({ note: z.string().trim().min(3).max(300) });

// ---- admin -----------------------------------------------------------------------------

export const adminBrandsQuerySchema = z.object({
  status: z.enum(BRAND_VERIFICATION_STATUSES).optional(),
  q: z.string().trim().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const adminBrandRowSchema = z.object({
  id: z.string().uuid(),
  handle: z.string(),
  displayName: z.string(),
  avatarEmoji: z.string(),
  owner: personSchema.nullable(),
  teamSize: z.number().int(),
  verification: brandVerificationSchema,
  checklist: brandChecklistSchema,
  bannedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export const adminBrandsResponseSchema = z.object({ brands: z.array(adminBrandRowSchema) });
export const adminBrandEventSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(BRAND_EVENT_KINDS),
  actor: personSchema.nullable(),
  subject: personSchema.nullable(),
  detail: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
/** GET /admin/brands/:id: everything the review needs, the team, and the brand's wallet (its ledger is the account's). */
export const adminBrandDetailSchema = adminBrandRowSchema.extend({
  brand: brandSettingsSchema.omit({ role: true }),
  members: z.array(brandMemberSchema),
  invites: z.array(brandInviteSchema),
  events: z.array(adminBrandEventSchema),
  wallet: z.object({ cashKobo: z.number().int(), bonusKobo: z.number().int(), payoutAccounts: z.number().int() }),
});
/** POST /admin/brands/:id/approve { reason } · /request-changes { reason }: the reason is the note the brand sees. */
export const adminBrandDecisionSchema = z.object({ reason: reasonSchema });
/** POST /admin/brands/:id/approve: verified, and the corner approval opened. A repeat answers the same (replayed). */
export const adminBrandApproveResponseSchema = z.object({ status: z.literal("verified"), replayed: z.boolean(), cornerId: z.string().uuid() });
export type AdminBrandApproveResponse = z.infer<typeof adminBrandApproveResponseSchema>;
/** POST /admin/brands/:id/request-changes: sent back, with the note the brand's team sees. */
export const adminBrandChangesResponseSchema = z.object({ status: z.literal("changes_needed"), note: z.string() });
export type AdminBrandChangesResponse = z.infer<typeof adminBrandChangesResponseSchema>;

/**
 * GET /admin/brands/logos: verified brands' new logos waiting for review, longest waiting first, each beside the live
 * one (null: the brand had removed it).
 */
export const adminBrandLogoSchema = z.object({
  brand: personSchema,
  liveLogoUrl: z.string().nullable(),
  pending: pendingLogoSchema.extend({ submittedBy: personSchema.nullable() }),
});
export const adminBrandLogosResponseSchema = z.object({ logos: z.array(adminBrandLogoSchema) });
export const adminBrandLogosQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
/**
 * POST /admin/brands/:id/logo/approve · /logo/reject { key, reason }: the key is the pending logo the admin looked at
 * (409 pending_logo_changed if the team has sent another since). A rejection's reason is the note the team sees.
 */
export const adminBrandLogoDecisionSchema = z.object({ key: z.string().min(1).max(300), reason: reasonSchema });
export const adminBrandLogoDecisionResponseSchema = z.object({ status: z.enum(["approved", "rejected"]), logoKey: z.string().nullable() });
export type AdminBrandLogoDecisionResponse = z.infer<typeof adminBrandLogoDecisionResponseSchema>;
