/**
 * Accounts and onboarding: sign-in, guests, who's playing and where onboarding ends, phone and contacts.
 * The app and the API both use these, so a number is hashed and an email normalised the same way
 * on both sides (ADR 0006).
 */
import { z } from "zod";
import { ARCHETYPES } from "./about.js";

// ---------------------------------------------------------------- errors

/** A guest tried something only an account can do (money, boards, profiles, creating parties). */
export const SIGN_UP_REQUIRED = "sign_up_required";
/** 401: no session, or a token that doesn't verify (bad, expired, another project). Sign in again. */
export const UNAUTHORIZED = "unauthorized";
/**
 * 401: the token is valid but its account no longer exists (deleted, or a cleaned-up guest). The app
 * should sign out of Firebase and start a fresh anonymous session; retrying with this token never works.
 */
export const ACCOUNT_GONE = "account_gone";

// ---------------------------------------------------------------- email

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const emailSchema = z.string().trim().max(254).regex(EMAIL_RE, "not an email").transform((e) => e.toLowerCase());

/** The account key: lowercase. Two spellings of the same address are one account. */
export const accountEmail = (email: string) => email.trim().toLowerCase();

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * One person's mailbox, however it's spelled: lowercase, and for Gmail the dots and any +tag dropped
 * (Gmail delivers a.b+x@gmail.com to ab@gmail.com), with googlemail.com folded into gmail.com. The key
 * a sign-up bonus will be granted once per, when there is one (open question 5).
 */
export function normaliseEmail(email: string): string {
  const lower = accountEmail(email);
  const at = lower.lastIndexOf("@");
  const local = lower.slice(0, at), domain = lower.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return lower;
  return `${local.split("+")[0].replaceAll(".", "")}@gmail.com`;
}

export const EMAIL_CODE_LENGTH = 6;
export const EMAIL_CODE_TTL_SECONDS = 10 * 60;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_CODE_RESEND_SECONDS = 30;

export const emailStartSchema = z.object({ email: emailSchema });
export const emailVerifySchema = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/, "six digits") });

/** Which account a sign-in landed on: the guest's own, now signed up, or an account that already existed. */
export const SIGN_IN_ACCOUNTS = ["upgraded", "existing"] as const;
export type SignInAccount = (typeof SIGN_IN_ACCOUNTS)[number];

/** POST /auth/email/verify and /auth/exchange. */
export const signInResultSchema = z.object({
  /** Sign in to Firebase with this (signInWithCustomToken). */
  customToken: z.string().min(1),
  account: z.enum(SIGN_IN_ACCOUNTS),
});
export type SignInResult = z.infer<typeof signInResultSchema>;

/** POST /auth/email/start. */
export const emailStartResponseSchema = z.object({ sent: z.literal(true), expiresInSeconds: z.number().int(), resendAfterSeconds: z.number().int() });

// ---------------------------------------------------------------- Google and Apple (system browser + one-time code)

export const OAUTH_PROVIDERS = ["google", "apple"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** Identity providers an account can be reached by. "supabase" arrives with the migration (row 11b). */
export const IDENTITY_PROVIDERS = ["firebase", ...OAUTH_PROVIDERS] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

/** The one-time code the deep link carries lives this long, and works once. */
export const AUTH_EXCHANGE_TTL_SECONDS = 60;
/** The provider round trip (state, nonce, PKCE) must finish within this. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

const base64url = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
export const oauthStartSchema = z.object({
  provider: z.enum(OAUTH_PROVIDERS),
  /** Where the browser comes back to: one of the API's allowed return URLs (contestly://auth, https://play…/auth). */
  returnTo: z.string().min(1).max(200),
  /** The app's PKCE challenge: base64url(SHA-256(verifier)). The verifier is sent only to /auth/exchange. */
  challenge: base64url,
});
export const authExchangeSchema = z.object({ code: base64url, verifier: base64url });
/** POST /auth/oauth/start: where to open the system browser. */
export const oauthStartResponseSchema = z.object({ url: z.string().url() });

// ---------------------------------------------------------------- onboarding

/** Who's playing: a person, or a brand. Picks which About you set they answer. */
export const WHO = ["person", "brand"] as const;
export type Who = (typeof WHO)[number];

/** Guests are named "Guest" with a handle nobody chooses; the Profile screen replaces both. */
export const GUEST_HANDLE_PREFIX = "guest_";
export const guestNameSchema = z.object({ displayName: z.string().trim().min(2).max(40) });

export const onboardingInviteSchema = z.object({ partyId: z.string().uuid().nullable() });

/** GET /onboarding (and PATCH /me/onboarding, PUT /onboarding/invite): what onboarding has, and where it goes next. */
export const onboardingStateSchema = z.object({
  signedUp: z.boolean(),
  /** Null until asked: no pick is asked twice. */
  who: z.enum(WHO).nullable(),
  /** The About you version answered; null until then. GET /me/onboarding has the answers. */
  aboutVersion: z.number().int().nullable(),
  lanes: z.array(z.string()),
  /** What Home leads with (grinder: The Climb). Brands are host. Null before About you. */
  archetype: z.enum(ARCHETYPES).nullable(),
  profileDone: z.boolean(),
  /** The staked invite opened before sign-up, so onboarding ends in its lobby. */
  invite: z.object({
    partyId: z.string().uuid(), status: z.string(), staked: z.boolean(), entryKobo: z.number().int(), joined: z.boolean(), canAfford: z.boolean(),
  }).nullable(),
  next: z.enum(["home", "lobby"]),
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

// ---------------------------------------------------------------- deleting an account (ADR 0010)

/**
 * A soft delete: the row, its id and the ledger stay so the account can always be traced; everything
 * people see of it goes. The live handle becomes this prefix plus part of the id, the name and face the
 * ones below, so past chat lines and results read "Deleted player" with no per-screen rule.
 */
export const DELETED_HANDLE_PREFIX = "deleted_";
export const DELETED_DISPLAY_NAME = "Deleted player";
export const DELETED_AVATAR_EMOJI = "👤";

/** Deleting needs a sign-in (email code, Google or Apple) to the same account this recently. */
export const REVERIFY_WINDOW_SECONDS = 5 * 60;

export const DELETION_REASONS = ["not_using", "too_many_notifications", "privacy", "another_account", "other"] as const;
export type DeletionReason = (typeof DELETION_REASONS)[number];

/** 403: sign in again (email code, Google or Apple) first; then DELETE /me within REVERIFY_WINDOW_SECONDS. */
export const REVERIFY_REQUIRED = "reverify_required";
/** 409: there's cash in the wallet. Until withdrawals exist (row 10), support pays it out. */
export const CASH_BALANCE = "cash_balance";
/** 409: seated in or hosting a party that hasn't finished or been cancelled. */
export const ACTIVE_PARTY = "active_party";
/** What the app shows for each blocker. */
export const DELETION_BLOCKER_MESSAGES = {
  [CASH_BALANCE]: "Contact support to withdraw first",
  [ACTIVE_PARTY]: "Finish or leave your open parties first",
} as const;
export type DeletionBlocker = keyof typeof DELETION_BLOCKER_MESSAGES;
/** active_party when one of the parties can't be left right now (it starts within the lock, or is live). */
export const ACTIVE_PARTY_STARTS_SOON_MESSAGE = "A party you're in starts soon. Try again once it's over";

/**
 * For active_party, each party in the way and what the person can do about it: leave it now, wait
 * (starts_soon: inside the leave lock, or already live), or it's theirs (host: hosts can't leave, and
 * only an admin can cancel a party today).
 */
export const BLOCKING_PARTY_ACTIONS = ["leave", "starts_soon", "host"] as const;
export const blockingPartySchema = z.object({
  id: z.string().uuid(), title: z.string(), startsAt: z.string().datetime(), action: z.enum(BLOCKING_PARTY_ACTIONS),
});
export type BlockingParty = z.infer<typeof blockingPartySchema>;
/** A blocker as GET /me/deletion lists it and DELETE /me's 409 carries it in `details`. */
export const deletionBlockerViewSchema = z.object({
  code: z.enum([CASH_BALANCE, ACTIVE_PARTY]), message: z.string(),
  /** active_party only. */
  parties: z.array(blockingPartySchema).optional(),
});
export type DeletionBlockerView = z.infer<typeof deletionBlockerViewSchema>;

/** DELETE /me. */
export const deleteAccountSchema = z.object({ reason: z.enum(DELETION_REASONS).optional() });

/** GET /me/deletion: what would stop a delete now, and whether the re-verification is fresh. */
export const deletionStatusSchema = z.object({
  /** Null when not re-verified in the window; else when the window closes. */
  reverifiedUntil: z.string().datetime().nullable(),
  blockers: z.array(deletionBlockerViewSchema),
  reasons: z.array(z.enum(DELETION_REASONS)),
});
export type DeletionStatus = z.infer<typeof deletionStatusSchema>;
export const deleteAccountResponseSchema = z.object({ deleted: z.literal(true) });

/**
 * app_config "accounts". `deletedArchiveRetentionDays`: after this many days a deleted account's archive
 * (email, phone, name, face, bio, About you answers) is cleared, keeping the row, its id and the ledger.
 * Null = never (shipped that way until the privacy policy sets the period).
 */
export const accountsConfigSchema = z.object({ deletedArchiveRetentionDays: z.number().int().min(1).max(3650).nullable() });
export type AccountsConfig = z.infer<typeof accountsConfigSchema>;
export const DEFAULT_ACCOUNTS_CONFIG: AccountsConfig = { deletedArchiveRetentionDays: null };

// ---------------------------------------------------------------- staked parties and guests

/** A party with money in it: an entry fee, or a cash prize to win. Guests can't join these. */
export const isStaked = (p: { entryKobo: number; funding: string; prizeKind: string; hostPoolKobo: number }) =>
  p.entryKobo > 0 || (p.funding === "host" && p.prizeKind === "cash" && p.hostPoolKobo > 0);

// ---------------------------------------------------------------- phone and contacts

/**
 * A Nigerian-first E.164 normaliser: "0803 000 0000", "803…", "234…" and "+234…" all become
 * "+2348030000000". Other countries need their "+" prefix. Returns null for anything that isn't a number.
 */
export function normalisePhone(raw: string): string | null {
  const plus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (plus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.startsWith("234") && digits.length === 13) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+234${digits.slice(1)}`;
  if (digits.length === 10 && /^[789]/.test(digits)) return `+234${digits}`;
  return null;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** What the app sends for each contact: lowercase hex SHA-256 of the E.164 number. The server never sees the number. */
export async function phoneHash(e164: string): Promise<string> {
  return hex(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(e164)));
}

export const phoneHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** Per request; and per user per Lagos day, CONTACT_SYNCS_PER_DAY requests and CONTACT_HASHES_PER_DAY hashes in all. */
export const CONTACT_HASHES_PER_REQUEST = 1000;
export const CONTACT_SYNCS_PER_DAY = 2;
export const CONTACT_HASHES_PER_DAY = 2000;
export const contactsMatchSchema = z.object({ hashes: z.array(phoneHashSchema).min(1).max(CONTACT_HASHES_PER_REQUEST) });

/** The ID token from verifying the number with Firebase phone auth on a secondary app instance (not linked). */
export const addPhoneSchema = z.object({ idToken: z.string().min(20).max(4096) });
export const addPhoneResponseSchema = z.object({ phoneAdded: z.literal(true) });

// ---------------------------------------------------------------- email providers (admin)

export const EMAIL_PROVIDERS = ["zeptomail", "brevo"] as const;
/** The email send log (addresses included) is kept this long, then the worker deletes it. */
export const EMAIL_SEND_RETENTION_DAYS = 30;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];
export const adminEmailSchema = z.object({ primary: z.enum(EMAIL_PROVIDERS) });
/** The other provider: what a failed send falls back to. */
export const backupOf = (primary: EmailProviderName): EmailProviderName => (primary === "zeptomail" ? "brevo" : "zeptomail");

/** GET/PUT /admin/email: which provider sends first, which are configured (keys never leave env), the last sends. */
export const adminEmailViewSchema = z.object({
  primary: z.enum(EMAIL_PROVIDERS),
  backup: z.enum(EMAIL_PROVIDERS),
  /** Null until the first save: the env default (EMAIL_PRIMARY) is in force. */
  version: z.number().int().nullable(),
  updatedAt: z.string().datetime().nullable(),
  providers: z.array(z.object({ name: z.enum(EMAIL_PROVIDERS), configured: z.boolean() })),
  recent: z.array(z.object({ id: z.string(), template: z.string(), to: z.string(), deliveredBy: z.string().nullable(),
    /** Each provider tried, in order: the fallback shows as a failed first attempt. */
    attempts: z.array(z.object({ provider: z.string(), ok: z.boolean(), error: z.string().optional() })),
    at: z.string().datetime() })),
});
export type AdminEmailView = z.infer<typeof adminEmailViewSchema>;
