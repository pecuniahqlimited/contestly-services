/**
 * The optional phone number (ADR 0006): verified by Firebase SMS on a secondary app instance and sent as
 * that ID token; never linked to the account, never a way to sign in, never shown. Contacts are matched
 * by HMAC over the app's SHA-256 of each number, against people who added a number; nothing sent is kept.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { db, liveUser, userByIdentity, users, type User } from "@contestly/db";
import { deleteFirebaseUser, verifyIdToken } from "@contestly/auth";
import { CONTACT_HASHES_PER_DAY, CONTACT_SYNCS_PER_DAY, lagosDay, normalisePhone, phoneHash } from "@contestly/shared";
import { httpError } from "./httpError.js";
import { limit } from "./redis.js";
import { phoneHmac } from "./signin/secrets.js";
import { personColumns, viewerRelations } from "./people.js";

/** The SMS check must be this recent: an old phone token proves nothing about today. */
const PHONE_CHECK_MAX_AGE_SECONDS = 10 * 60;
const DAY_SECONDS = 24 * 3600;

export async function addPhone(me: User, idToken: string) {
  const t = await verifyIdToken(idToken);
  if (!t?.phone_number) throw httpError(400, "invalid_phone_token");
  if (Date.now() / 1000 - t.auth_time > PHONE_CHECK_MAX_AGE_SECONDS) throw httpError(400, "phone_check_too_old");
  const phone = normalisePhone(t.phone_number);
  if (!phone) throw httpError(400, "invalid_phone_token");
  const hmac = phoneHmac(await phoneHash(phone));
  const [taken] = await db.select({ id: users.id }).from(users).where(and(eq(users.phoneHmac, hmac), ne(users.id, me.id)));
  if (taken) throw httpError(409, "phone_in_use");
  await db.update(users).set({ phone, phoneVerifiedAt: new Date(), phoneHmac: hmac }).where(eq(users.id, me.id));
  // The phone check signed in a throwaway Firebase user; it isn't an account, so don't keep it.
  if (!(await userByIdentity("firebase", t.uid))) {
    await deleteFirebaseUser(t.uid).catch((e) => console.warn(`[phone] couldn't delete the phone-check user ${t.uid}:`, e));
  }
  return { phoneAdded: true };
}

/** People among the viewer's contacts who added a number. Capped per request (schema) and per Lagos day. */
export async function matchContacts(me: User, hashes: string[]) {
  const day = lagosDay();
  await limit(`contacts:syncs:${me.id}:${day}`, CONTACT_SYNCS_PER_DAY, DAY_SECONDS, "contacts_limit");
  await limit(`contacts:hashes:${me.id}:${day}`, CONTACT_HASHES_PER_DAY, DAY_SECONDS, "contacts_limit", hashes.length);
  const hmacs = [...new Set(hashes)].map(phoneHmac);
  const rows = await db.select(personColumns).from(users)
    .where(and(inArray(users.phoneHmac, hmacs), eq(users.isGuest, false), eq(users.isSystem, false), ne(users.id, me.id), liveUser));
  const relations = await viewerRelations(me.id, rows.map((r) => r.id));
  return { matches: rows.map((r) => ({ ...r, viewer: relations.get(r.id)! })) };
}
