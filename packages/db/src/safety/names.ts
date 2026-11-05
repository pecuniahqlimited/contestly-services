/**
 * Names people set (ADR 0014): the shared filter with ops' extra terms from the safety config. A refusal is
 * 422 name_not_allowed with the field (never the word); otherwise the text to keep, masked where needed.
 */
import { NAME_NOT_ALLOWED, checkName, type NameField } from "@contestly/shared";
import { db, type Tx } from "../client.js";
import { getSafetyConfig } from "../config.js";

export async function cleanName(field: NameField, text: string, conn: Tx | typeof db = db): Promise<string> {
  const cfg = await getSafetyConfig(conn);
  const out = checkName(text, field, cfg);
  if (!out.ok) throw Object.assign(new Error(NAME_NOT_ALLOWED), { statusCode: 422, details: { field } });
  return out.text;
}

/** The same for an optional or nullable field: left as it came when there's nothing to check. */
export async function cleanOptionalName<T extends string | null | undefined>(field: NameField, text: T): Promise<T> {
  return (typeof text === "string" && text ? await cleanName(field, text) : text) as T;
}
