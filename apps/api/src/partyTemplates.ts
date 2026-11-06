/**
 * Party templates from the API's side (ADR 0015): what the builder is offered, and what a template fills in when
 * a party is made from it. The config is versioned admin data (currentPartyTemplates); a party keeps its own copy.
 */
import { currentPartyTemplates, partyTemplatesVersion, type PartyTemplatesRow } from "@contestly/db";
import {
  templateCopy, templatePrefill, type HostWrittenRules, type PartyTemplate, type PartyTemplateCopy, type PartyTemplatesResponse, type PartyTemplatesVersion,
} from "@contestly/shared";
import { httpError } from "./httpError.js";

export const templatesVersionView = (row: PartyTemplatesRow): PartyTemplatesVersion => ({ version: row.version, config: row.config, createdAt: row.createdAt.toISOString() });

/** GET /party-templates: the current version's templates, hidden ones left out, and the caps the Stakes scene shows. */
export async function offeredTemplates(): Promise<PartyTemplatesResponse> {
  const { version, config } = await currentPartyTemplates();
  const { outlierMarginPct: _margin, recentBlockDays: _blocks, ...rules } = config.rules;
  return { version, templates: config.templates.filter((t) => !t.hidden).map(({ hidden: _h, ...t }) => t), rules };
}

/** The template a party asked for, in the version the builder showed it. Refused if that version doesn't have it. */
async function templateAt(ref: { id: string; version: number }): Promise<PartyTemplate> {
  const row = await partyTemplatesVersion(ref.version);
  const t = row?.config.templates.find((x) => x.id === ref.id);
  if (!t) throw httpError(422, "template_not_found");
  return t;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A create-party body with the template's fields laid under it: whatever the host sent wins, anything left out
 * comes from the template. Returns the body (to validate as usual) and the party's copy of the template. A body
 * with no template passes through untouched.
 */
export async function withTemplate(raw: unknown): Promise<{ body: unknown; copy: PartyTemplateCopy | null }> {
  if (!isObject(raw) || !isObject(raw.template)) return { body: raw, copy: null };
  const ref = { id: String(raw.template.id ?? ""), version: Number(raw.template.version) };
  const t = await templateAt(ref);
  const sent = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  return { body: { ...templatePrefill(t), ...sent }, copy: templateCopy(t, ref.version) };
}

/** The host-written rules new parties are checked against and keep a copy of. */
export const currentHostRules = async (): Promise<HostWrittenRules> => (await currentPartyTemplates()).config.rules;
