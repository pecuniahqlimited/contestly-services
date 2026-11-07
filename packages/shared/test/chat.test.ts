import { describe, expect, it } from "vitest";
import { chatSendSchema, dmKey, dmPermission, maskProfanity, partyChatFromOutside, partyChatOpenIn, type DmFacts } from "../src/index.js";

const person = { isGuest: false, isBrand: false, isSystem: false };
const facts = (over: Partial<DmFacts> = {}): DmFacts => ({
  sender: person, recipient: { ...person, isDeleted: false }, contacts: false, playedTogether: false, shareCrew: false, joinedSendersParty: false, blocked: false, talking: false, ...over,
});

describe("dmPermission", () => {
  it("asks a stranger with a request", () => expect(dmPermission(facts())).toBe("request"));
  it("refuses a deleted account, whatever connects them", () => {
    expect(dmPermission(facts({ recipient: { ...person, isDeleted: true }, contacts: true, playedTogether: true, shareCrew: true }))).toBe("refused");
  });
  it("is direct between contacts (ADR 0012)", () => expect(dmPermission(facts({ contacts: true }))).toBe("direct"));
  it("has no follow rule any more: following someone's corner opens nothing", () => {
    expect(Object.keys(facts())).not.toContain("recipientFollowsSender");
    expect(dmPermission(facts())).toBe("request");
  });
  it("is direct after a finished party together", () => expect(dmPermission(facts({ playedTogether: true }))).toBe("direct"));
  it("is direct between crewmates", () => expect(dmPermission(facts({ shareCrew: true }))).toBe("direct"));
  it("refuses guests on either side", () => {
    expect(dmPermission(facts({ sender: { ...person, isGuest: true }, contacts: true }))).toBe("refused");
    expect(dmPermission(facts({ recipient: { ...person, isGuest: true }, playedTogether: true }))).toBe("refused");
  });
  it("refuses system accounts", () => expect(dmPermission(facts({ recipient: { ...person, isSystem: true } }))).toBe("refused"));
  it("lets a brand write only to people who joined its parties, and never as a request", () => {
    const brand = { ...person, isBrand: true };
    expect(dmPermission(facts({ sender: brand, joinedSendersParty: true }))).toBe("direct");
    expect(dmPermission(facts({ sender: brand }))).toBe("refused");
    expect(dmPermission(facts({ sender: brand, contacts: true, playedTogether: true }))).toBe("refused");
  });
  it("is direct once the two already talk (an accepted request), unless blocked", () => {
    expect(dmPermission(facts({ talking: true }))).toBe("direct");
    expect(dmPermission(facts({ talking: true, blocked: true }))).toBe("refused");
    expect(dmPermission(facts({ talking: true, recipient: { ...person, isDeleted: true } }))).toBe("refused");
  });
});

describe("party chat gating", () => {
  it("is open in the lobby, on standings and after, never on a question or reveal", () => {
    for (const phase of ["lobby", "generating", "standings", "finished"]) expect(partyChatOpenIn(phase)).toBe(true);
    for (const phase of ["question", "reveal", "cancelled"]) expect(partyChatOpenIn(phase)).toBe(false);
  });
  const now = new Date("2026-10-26T12:00:00Z");
  const cfg = { postGameChatHours: 24 };
  it("from outside the room: open before, closed while live, open for the window after", () => {
    expect(partyChatFromOutside({ status: "open", endedAt: null, startsAt: now }, now, cfg)).toBe("open");
    expect(partyChatFromOutside({ status: "live", endedAt: null, startsAt: now }, now, cfg)).toBe("join_the_round");
    expect(partyChatFromOutside({ status: "finished", endedAt: new Date("2026-10-25T13:00:00Z"), startsAt: now }, now, cfg)).toBe("open");
    expect(partyChatFromOutside({ status: "finished", endedAt: new Date("2026-10-25T11:59:00Z"), startsAt: now }, now, cfg)).toBe("chat_ended");
  });
  it("counts a party with no end time from its start", () => {
    expect(partyChatFromOutside({ status: "cancelled", endedAt: null, startsAt: new Date("2026-10-20T12:00:00Z") }, now, cfg)).toBe("chat_ended");
  });
});

describe("maskProfanity", () => {
  it("masks whole words, any case, keeping the first letter", () => expect(maskProfanity("oh SHIT that was fast")).toBe("oh S*** that was fast"));
  it("leaves words that only contain one", () => expect(maskProfanity("Scunthorpe shitake? no: shiitake")).toBe("Scunthorpe shitake? no: shiitake"));
});

describe("chatSendSchema", () => {
  const id = "6f1c3b2e-0d2a-4c1e-9a7b-1f2e3d4c5b6a";
  it("takes exactly one of text, a sticker or a voice note, with a client message id", () => {
    expect(chatSendSchema.safeParse({ clientMsgId: id, text: "hi" }).success).toBe(true);
    expect(chatSendSchema.safeParse({ clientMsgId: id, text: "hi", sticker: "🔥" }).success).toBe(false);
    expect(chatSendSchema.safeParse({ clientMsgId: id }).success).toBe(false);
    expect(chatSendSchema.safeParse({ text: "hi" }).success).toBe(false);
  });
  it("refuses blank text", () => expect(chatSendSchema.safeParse({ clientMsgId: id, text: "   " }).success).toBe(false));
});

describe("dmKey", () => {
  it("is the same whoever writes first", () => expect(dmKey("b", "a")).toBe(dmKey("a", "b")));
});
