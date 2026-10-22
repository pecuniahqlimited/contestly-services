/**
 * Accounts and onboarding: sign-in, guests, the onboarding picks and round, phone and contacts.
 * The app and the API both use these, so a number is hashed and an email normalised the same way
 * on both sides (ADR 0006).
 */
import { z } from "zod";
import { CATEGORIES } from "./categories.js";

const kobo = (naira: number) => naira * 100;

// ---------------------------------------------------------------- errors

/** A guest tried something only an account can do (money, boards, profiles, creating parties). */
export const SIGN_UP_REQUIRED = "sign_up_required";

// ---------------------------------------------------------------- email

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const emailSchema = z.string().trim().max(254).regex(EMAIL_RE, "not an email").transform((e) => e.toLowerCase());

/** The account key: lowercase. Two spellings of the same address are one account. */
export const accountEmail = (email: string) => email.trim().toLowerCase();

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * The onboarding-bonus key: lowercase, and for Gmail the dots and any +tag dropped (Gmail delivers
 * a.b+x@gmail.com to ab@gmail.com), with googlemail.com folded into gmail.com.
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

/**
 * What happened to the onboarding round's coins at sign-up. "already_claimed": this email (or a
 * Gmail alias of it) had them already. "device_claimed": this device had them for another account.
 * "none": no round, or nothing to claim (an existing account never takes a guest's coins).
 */
export const ONBOARDING_BONUS_OUTCOMES = ["granted", "already_claimed", "device_claimed", "none"] as const;
export type OnboardingBonusOutcome = (typeof ONBOARDING_BONUS_OUTCOMES)[number];

export interface SignInResult {
  /** Sign in to Firebase with this (signInWithCustomToken). */
  customToken: string;
  account: SignInAccount;
  onboardingBonus: OnboardingBonusOutcome;
  bonusKobo: number;
}

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

// ---------------------------------------------------------------- onboarding picks

export const WHO = ["person", "brand"] as const;
export type Who = (typeof WHO)[number];
/** "Why you're here" for a person is the archetype; it only changes what Home leads with. */
export const ARCHETYPES = ["competitor", "host", "grinder", "fan"] as const;
export type Archetype = (typeof ARCHETYPES)[number];
export const BRAND_WHYS = ["launch", "reach", "reward", "culture"] as const;
export const WHYS = [...ARCHETYPES, ...BRAND_WHYS] as const;
export type Why = (typeof WHYS)[number];

export const onboardingPicksSchema = z.object({
  who: z.enum(WHO).optional(),
  /** Lanes (multi-select); stored as the user's interests. */
  lanes: z.array(z.enum(CATEGORIES)).min(1).max(10).optional(),
  why: z.enum(WHYS).optional(),
}).refine((p) => Object.keys(p).length > 0, "nothing to save");
export type OnboardingPicksInput = z.infer<typeof onboardingPicksSchema>;

/** A person's "why" fits the person answers, a brand's the brand ones. */
export function whyFits(who: Who | null, why: Why): boolean {
  if (who === "brand") return (BRAND_WHYS as readonly string[]).includes(why);
  return (ARCHETYPES as readonly string[]).includes(why);
}

/** A person's archetype is their "why"; brands have none. */
export const archetypeOf = (who: string | null, why: string | null): Archetype | null =>
  who !== "brand" && why && (ARCHETYPES as readonly string[]).includes(why) ? (why as Archetype) : null;

/** Guests are named "Guest" with a handle nobody chooses; the Profile screen replaces both. */
export const GUEST_HANDLE_PREFIX = "guest_";
export const guestNameSchema = z.object({ displayName: z.string().trim().min(2).max(40) });

export const onboardingInviteSchema = z.object({ partyId: z.string().uuid().nullable() });

// ---------------------------------------------------------------- the onboarding round

export const ONBOARDING_ROOM = "onboarding";
/** Messages the onboarding room adds to the party protocol (it reuses question / reveal / standings / final). */
export const ONBOARDING_MSG = {
  /** Waiting to start: { players, startsAt }. The count is the real number in the room. */
  lobby: "onboarding:lobby",
  /** This player's result: OnboardingResult. */
  result: "onboarding:result",
} as const;

export const onboardingConfigSchema = z.object({
  /** How long a new room waits for others onboarding at the same moment before it starts. */
  waitSeconds: z.number().int().min(0).max(30),
  maxPlayers: z.number().int().min(1).max(20),
  questionCount: z.number().int().min(1).max(5),
  questionSeconds: z.number().int().min(5).max(30),
  revealSeconds: z.number().int().min(1).max(10),
  standingsSeconds: z.number().int().min(1).max(10),
  basePoints: z.number().int().positive(),
  maxSpeedBonus: z.number().int().min(0),
  /** Bank questions this hard or easier (0 everyone gets it … 1 nobody does). */
  maxDifficulty: z.number().min(0).max(1),
  /** Alone: coins by points, best tier first. */
  soloTiers: z.array(z.object({ minPoints: z.number().int().min(0), coinsKobo: z.number().int().min(0) })).min(1),
  /** Shared: coins by rank (1st, 2nd, …); everyone past the list gets the last. Everyone is paid. */
  sharedByRankKobo: z.array(z.number().int().min(0)).min(1),
});
export type OnboardingConfig = z.infer<typeof onboardingConfigSchema>;
export const DEFAULT_ONBOARDING_CONFIG: OnboardingConfig = {
  waitSeconds: 6,
  maxPlayers: 8,
  questionCount: 3,
  questionSeconds: 10,
  revealSeconds: 3,
  standingsSeconds: 3,
  basePoints: 200,
  maxSpeedBonus: 100,
  maxDifficulty: 0.5,
  soloTiers: [
    { minPoints: 800, coinsKobo: kobo(500) },
    { minPoints: 500, coinsKobo: kobo(400) },
    { minPoints: 200, coinsKobo: kobo(300) },
    { minPoints: 0, coinsKobo: kobo(200) },
  ],
  sharedByRankKobo: [kobo(500), kobo(400), kobo(300), kobo(200)],
};

/** Solo coins for a score: the best tier it reaches (the last tier catches everything). */
export function soloCoins(points: number, tiers: OnboardingConfig["soloTiers"]): number {
  return (tiers.find((t) => points >= t.minPoints) ?? tiers[tiers.length - 1]).coinsKobo;
}
/** Shared-round coins for a rank (1-based). */
export const sharedCoins = (rank: number, byRank: number[]) => byRank[Math.min(rank, byRank.length) - 1];

export interface OnboardingResult {
  mode: "solo" | "shared";
  points: number;
  correct: number;
  questions: number;
  rank: number;
  players: number;
  /** Kept on the round until sign-up; then posted as bonus coins (once per email and device). */
  coinsKobo: number;
}

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

// ---------------------------------------------------------------- email providers (admin)

export const EMAIL_PROVIDERS = ["zeptomail", "brevo"] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];
export const adminEmailSchema = z.object({ primary: z.enum(EMAIL_PROVIDERS) });
/** The other provider: what a failed send falls back to. */
export const backupOf = (primary: EmailProviderName): EmailProviderName => (primary === "zeptomail" ? "brevo" : "zeptomail");
