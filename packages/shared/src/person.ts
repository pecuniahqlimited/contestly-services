import { z } from "zod";

/** A person as a face, a list row or a mention shows them. */
export const personSchema = z.object({
  id: z.string().uuid(),
  handle: z.string(),
  displayName: z.string(),
  avatarEmoji: z.string(),
  isVerified: z.boolean(),
});
export type Person = z.infer<typeof personSchema>;

// ---- people search (GET /users/search) ---------------------------------------------------

/** How you know someone, closest first: what a search row says under the name. */
export const PERSON_RELATIONSHIPS = ["in_your_crew", "in_your_contacts", "played_with_you"] as const;
export type PersonRelationship = (typeof PERSON_RELATIONSHIPS)[number];

/** What's searched: a leading @ and extra spaces dropped. Folding (case, accents) is the database's. */
export const searchText = (q: string) => q.trim().replace(/^@+/, "").replace(/\s+/g, " ").trim();
export const PEOPLE_SEARCH_MIN_CHARS = 2;
export const PEOPLE_SEARCH_MAX_CHARS = 40;
export const PEOPLE_SEARCH_DEFAULT = 20;
export const PEOPLE_SEARCH_MAX = 50;
const searchQ = z.string().transform(searchText).pipe(z.string().min(PEOPLE_SEARCH_MIN_CHARS).max(PEOPLE_SEARCH_MAX_CHARS));

/** GET /users/search?q=&limit=: a prefix of the handle, the name, or a word of the name; case and accents don't matter. */
export const peopleSearchQuerySchema = z.object({
  q: searchQ,
  limit: z.coerce.number().int().min(1).max(PEOPLE_SEARCH_MAX).default(PEOPLE_SEARCH_DEFAULT),
});

/** One result: the person, how you know them, and whether you can message them (dmPermission()). */
export const foundPersonSchema = personSchema.extend({
  /** One of your people (crew, contacts, played with lately): these come first. */
  yourPeople: z.boolean(),
  relationship: z.enum(PERSON_RELATIONSHIPS).nullable(),
  /** A message would get through: directly, or as a request. */
  canMessage: z.boolean(),
  /** A first message would be a request they accept (a few text lines, no voice). */
  messageIsRequest: z.boolean(),
});
export type FoundPerson = z.infer<typeof foundPersonSchema>;
/**
 * → { people }: your people first, then an exact handle, then the rest by name. Never you, guests, banned or
 * deleted accounts, or anyone blocked either way. 429 rate_limited past the per-user limit.
 */
export const peopleSearchResponseSchema = z.object({ people: z.array(foundPersonSchema) });
export type PeopleSearchResponse = z.infer<typeof peopleSearchResponseSchema>;
