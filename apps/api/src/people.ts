/** People as the API shows them, and the viewer's people (ADR 0012). */
import { yourPeople, type User } from "@contestly/db";
import { users } from "@contestly/db";
import type { Person } from "@contestly/shared";

/** Select these to get a Person straight from a query. */
export const personColumns = { id: users.id, handle: users.handle, displayName: users.displayName, avatarEmoji: users.avatarEmoji, isVerified: users.isVerified };

export const toPerson = (u: User): Person => ({ id: u.id, handle: u.handle, displayName: u.displayName, avatarEmoji: u.avatarEmoji, isVerified: u.isVerified });

/** The viewer's people (crew, contacts, played with lately); nobody when signed out. */
export const peopleOf = async (viewerId: string | undefined): Promise<Set<string>> => (viewerId ? yourPeople(viewerId) : new Set());
