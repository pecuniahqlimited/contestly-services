import { describe, expect, it } from "vitest";
import { DEFAULT_CHALLENGE_CONFIG, challengeConfigSchema, challengeOpeningLine, challengeFieldsSchema, challengeRangeProblem, challengeState, createPartySchema, type ChallengeStateInput } from "../src/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-11-10T12:00:00Z");
const base: ChallengeStateInput = { partyStatus: "open", ending: null, windowOpen: false, inviteExpiresAt: new Date(now.getTime() + 60_000), myAnswer: "pending", now };

describe("challenge ranges", () => {
  it("defaults sit inside their ranges, and a config with the default outside is refused", () => {
    expect(challengeConfigSchema.parse(DEFAULT_CHALLENGE_CONFIG)).toEqual(DEFAULT_CHALLENGE_CONFIG);
    expect(challengeConfigSchema.safeParse({ ...DEFAULT_CHALLENGE_CONFIG, joinWindowMinutes: { min: 5, max: 60, default: 61 } }).success).toBe(false);
  });
  it("names the field outside its range, with the range", () => {
    expect(challengeRangeProblem({ inviteExpiresInMinutes: 60, joinWindowMinutes: 5 }, DEFAULT_CHALLENGE_CONFIG)).toBeNull();
    expect(challengeRangeProblem({ inviteExpiresInMinutes: 59, joinWindowMinutes: 10 }, DEFAULT_CHALLENGE_CONFIG)).toEqual({ field: "inviteExpiresInMinutes", min: 60, max: 2880 });
    expect(challengeRangeProblem({ inviteExpiresInMinutes: 60, joinWindowMinutes: 61 }, DEFAULT_CHALLENGE_CONFIG)).toEqual({ field: "joinWindowMinutes", min: 5, max: 60 });
  });
  it("each invitee once; a party body carries the fields", () => {
    expect(challengeFieldsSchema.safeParse({ invitees: [id, id], inviteExpiresInMinutes: 60, joinWindowMinutes: 10 }).success).toBe(false);
    const body = createPartySchema.parse({ title: "Ada vs Kemi", brief: "Afrobeats", entryKobo: 0, maxPlayers: 2, funding: "pooled", split: "winner", challenge: { invitees: [id], inviteExpiresInMinutes: 60, joinWindowMinutes: 10 } });
    expect(body.challenge?.invitees).toEqual([id]);
  });
});

describe("the card's state", () => {
  it("pending until the invite runs out: then no_answer for the invitee, expired for the challenger; accepted once the window opens", () => {
    const later = new Date(now.getTime() + 61_000);
    expect(challengeState(base)).toBe("pending");
    expect(challengeState({ ...base, now: later })).toBe("no_answer");
    expect(challengeState({ ...base, now: later, myAnswer: null })).toBe("expired");
    expect(challengeState({ ...base, windowOpen: true, myAnswer: "accepted" })).toBe("accepted");
    // Still asked when the window's open, but their own invite ran out.
    expect(challengeState({ ...base, windowOpen: true, now: later })).toBe("no_answer");
  });
  it("live and finished; cancelled by its ending, else by the challenger", () => {
    expect(challengeState({ ...base, partyStatus: "live", myAnswer: "accepted" })).toBe("live");
    expect(challengeState({ ...base, partyStatus: "finished", myAnswer: null })).toBe("finished");
    expect(challengeState({ ...base, partyStatus: "cancelled", ending: "declined" })).toBe("declined");
    expect(challengeState({ ...base, partyStatus: "cancelled", ending: "expired" })).toBe("expired");
    expect(challengeState({ ...base, partyStatus: "cancelled" })).toBe("cancelled");
  });
  it("the viewer's own decline, leave, no answer or no-show wins, whatever the others did", () => {
    expect(challengeState({ ...base, windowOpen: true, myAnswer: "declined" })).toBe("declined");
    expect(challengeState({ ...base, partyStatus: "live", myAnswer: "no_answer" })).toBe("no_answer");
    expect(challengeState({ ...base, partyStatus: "live", myAnswer: "no_show" })).toBe("no_show");
    expect(challengeState({ ...base, partyStatus: "cancelled", ending: "expired", myAnswer: "no_show" })).toBe("no_show");
    expect(challengeState({ ...base, partyStatus: "finished", myAnswer: "no_answer" })).toBe("no_answer");
    expect(challengeState({ ...base, windowOpen: true, myAnswer: "left" })).toBe("left");
    expect(challengeState({ ...base, partyStatus: "cancelled", ending: "expired", myAnswer: "left" })).toBe("left");
  });
});

describe("challengeOpeningLine", () => {
  it("names one, two or several people asked", () => {
    expect(challengeOpeningLine("Ada", ["Kemi"])).toBe("Ada challenged Kemi");
    expect(challengeOpeningLine("Ada", ["Kemi", "Tolu"])).toBe("Ada challenged Kemi and Tolu");
    expect(challengeOpeningLine("Ada", ["Kemi", "Tolu", "Zee"])).toBe("Ada challenged Kemi, Tolu and Zee");
  });
});
