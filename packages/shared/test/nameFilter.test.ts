import { describe, expect, it } from "vitest";
import { checkName, moderationActionBodySchema, reportBodySchema, dmPermission } from "../src/index.js";

const refused = (text: string, field: Parameters<typeof checkName>[1] = "displayName") => !checkName(text, field).ok;
const kept = (text: string, field: Parameters<typeof checkName>[1] = "displayName") => {
  const out = checkName(text, field);
  if (!out.ok) throw new Error(`refused ${text}`);
  return out.text;
};

describe("checkName (ADR 0014)", () => {
  it("refuses slurs anywhere, whatever the case, accents or look-alike digits", () => {
    expect(refused("Big Nyamiri")).toBe(true);
    expect(refused("NYÁMIRI")).toBe(true);
    expect(refused("ny4m1r1 fan club", "partyTitle")).toBe(true);
    expect(refused("ofe   mmanu crew", "crewName")).toBe(true);
    expect(refused("omo ale", "cornerName")).toBe(true);
    expect(refused("you shege", "bio")).toBe(true);
  });

  it("masks milder words in names, titles and bios, keeping the first letter", () => {
    expect(kept("Mumu Quiz Night", "partyTitle")).toBe("M*** Quiz Night");
    expect(kept("no werey allowed", "bio")).toBe("no w**** allowed");
    expect(kept("shit happens", "crewName")).toBe("s*** happens");
  });

  it("refuses milder words in a handle, which can't carry a mask, and slurs hidden inside one", () => {
    expect(refused("mumu_king", "handle")).toBe(true);
    expect(refused("xnyamirix", "handle")).toBe(true);
    expect(refused("omo.ale", "handle")).toBe(true);
  });

  it("leaves ordinary names alone, including surnames that look like other words", () => {
    for (const name of ["Ada Obi", "Tunde Gambari", "Essex quiz", "Aboki FC", "Bashir", "Scunthorpe", "olodumare"]) expect(kept(name)).toBe(name);
    expect(kept("shegeboy")).toBe("shegeboy"); // only handles are searched inside words
    expect(checkName("tolu_99", "handle").ok).toBe(true);
  });

  it("takes ops' own terms from config", () => {
    const extra = { blockedTerms: ["badword"], maskedTerms: ["meh"] };
    expect(checkName("a badword here", "displayName", extra).ok).toBe(false);
    expect(checkName("so meh", "displayName", extra)).toEqual({ ok: true, text: "so m**" });
  });

  it("keeps emoji and positions intact", () => {
    expect(kept("🔥 mumu 🔥", "partyTitle")).toBe("🔥 m*** 🔥");
  });
});

describe("report and action bodies", () => {
  it("needs a note for other, and hours for timed actions", () => {
    const target = { type: "user", id: "00000000-0000-4000-8000-000000000000" };
    expect(reportBodySchema.safeParse({ target, reason: "other" }).success).toBe(false);
    expect(reportBodySchema.safeParse({ target, reason: "other", note: "they keep asking for my account number" }).success).toBe(true);
    expect(reportBodySchema.safeParse({ target, reason: "spam_scam" }).success).toBe(true);
    expect(moderationActionBodySchema.safeParse({ action: "suspend", reason: "repeated harassment" }).success).toBe(false);
    expect(moderationActionBodySchema.safeParse({ action: "suspend", reason: "repeated harassment", hours: 24 }).success).toBe(true);
  });
});

describe("dmPermission with a block", () => {
  it("refuses when either has blocked the other, even crew mates", () => {
    const base = { sender: { isGuest: false, isBrand: false, isSystem: false }, recipient: { isGuest: false, isSystem: false, isDeleted: false }, contacts: true, playedTogether: true, shareCrew: true, joinedSendersParty: false };
    expect(dmPermission({ ...base, blocked: false })).toBe("direct");
    expect(dmPermission({ ...base, blocked: true })).toBe("refused");
  });
});
