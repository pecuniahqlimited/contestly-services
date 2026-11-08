/**
 * Finding people by name (GET /users/search, and asking anyone to follow your corner). A prefix match on the
 * handle, the display name, or any word of the name, folded (lower case, accents off: contestly_fold,
 * migration 0049) on both sides. Never you, a guest, a system account, a banned or deleted account, or anyone
 * blocked either way (ADR 0014); sim accounts only to sims. Ranked: your people first (ADR 0012), then an
 * exact handle, then a handle that starts with it, then by name.
 */
import { and, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { searchText, type PersonRelationship } from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { contactMatches, crewMembers, crews, playedWith, users, type User } from "./schema.js";
import { liveUser } from "./accounts.js";
import { notBlockedWith } from "./safety/people.js";
import { simVisibleTo } from "./sim.js";
import { yourPeople } from "./social.js";

type Conn = Tx | typeof db;

export interface PeopleSearchOptions {
  /** The query as typed: a leading @ and surrounding spaces are dropped; at least 2 characters are left (the schema checks). */
  q: string;
  limit: number;
  /** More conditions on users (e.g. not already following a corner). */
  where?: SQL;
}

export interface FoundPerson {
  id: string;
  handle: string;
  displayName: string;
  avatarEmoji: string;
  isVerified: boolean;
  /** A brand's account (ADR 0017). */
  isBrand: boolean;
  isGuest: boolean;
  isSystem: boolean;
  deletedAt: Date | null;
  /** One of the viewer's people (crew, contacts, played with lately). */
  yourPeople: boolean;
  /** The closest tie, for the row's line: in your crew, in your contacts, played with you (ever). */
  relationship: PersonRelationship | null;
}

/** What LIKE treats as wildcards, escaped, so a typed % or _ is just a character. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** users.id, qualified: inside a select's subqueries Drizzle prints a bare "id", which a joined table's own id would take. */
const userId = sql.raw(`"users"."id"`);

/** How the viewer knows each users row, as select columns; relationshipOf() turns them into the row's tie. */
export const relationshipColumns = (viewerId: string) => ({
  crew: sql<boolean>`exists (select 1 from ${crewMembers} a join ${crewMembers} b on b.crew_id = a.crew_id join ${crews} c on c.id = a.crew_id
    where a.user_id = ${viewerId} and b.user_id = ${userId} and c.archived_at is null)`,
  contact: sql<boolean>`exists (select 1 from ${contactMatches} m where (m.user_id = ${viewerId} and m.contact_user_id = ${userId}) or (m.user_id = ${userId} and m.contact_user_id = ${viewerId}))`,
  played: sql<boolean>`exists (select 1 from ${playedWith} p where (p.user_a = ${viewerId} and p.user_b = ${userId}) or (p.user_a = ${userId} and p.user_b = ${viewerId}))`,
});
/** The closest tie: a crew, then contacts, then having played together (ever). */
export const relationshipOf = (r: { crew: boolean; contact: boolean; played: boolean }): PersonRelationship | null =>
  r.crew ? "in_your_crew" : r.contact ? "in_your_contacts" : r.played ? "played_with_you" : null;

const fold = (col: SQL | typeof users.handle | typeof users.displayName) => sql`contestly_fold(${col})`;

export async function searchPeople(viewer: User, opts: PeopleSearchOptions, conn: Conn = db): Promise<FoundPerson[]> {
  const text = searchText(opts.q);
  const people = [...(await yourPeople(viewer.id, conn))];
  const v = sql`contestly_fold(${likeEscape(text)})`;
  const prefix = sql`${v} || '%'`;
  const anyWord = sql`'% ' || ${v} || '%'`;
  const inPeople = people.length ? sql`(${inArray(users.id, people)})` : sql`false`;
  const rows = await conn.select({
    id: users.id, handle: users.handle, displayName: users.displayName, avatarEmoji: users.avatarEmoji, isVerified: users.isVerified, isBrand: users.isBrand,
    isGuest: users.isGuest, isSystem: users.isSystem, deletedAt: users.deletedAt,
    yourPeople: sql<boolean>`${inPeople}`,
    ...relationshipColumns(viewer.id),
  }).from(users).where(and(
    ne(users.id, viewer.id), eq(users.isGuest, false), eq(users.isSystem, false), liveUser, isNull(users.bannedAt),
    notBlockedWith(viewer.id, users.id), simVisibleTo(viewer, users.isSim), opts.where,
    sql`(${fold(users.handle)} like ${prefix} or ${fold(users.displayName)} like ${prefix} or ${fold(users.displayName)} like ${anyWord})`,
  )).orderBy(
    // A bare constant isn't allowed in ORDER BY: with no people, that term is left out.
    ...(people.length ? [sql`${inPeople} desc`] : []), sql`(${fold(users.handle)} = ${v}) desc`, sql`(${fold(users.handle)} like ${prefix}) desc`, users.displayName, users.handle,
  ).limit(opts.limit);
  return rows.map(({ crew, contact, played, ...r }) => ({ ...r, yourPeople: !!r.yourPeople, relationship: relationshipOf({ crew, contact, played }) }));
}
