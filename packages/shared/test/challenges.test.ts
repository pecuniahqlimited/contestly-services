import { describe, expect, it } from "vitest";
import { DEFAULT_CHALLENGE_CONFIG, challengeConfigSchema, challengeFieldsSchema, challengeRangeProblem, challengeState, createPartySchema, type ChallengeStateInput } from "../src/index.js";

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
  it("pending until the invite runs out, then expired; accepted once the window opens", () => {
    expect(challengeState(base)).toBe("pending");
    expect(challengeState({ ...base, now: new Date(now.getTime() + 61_000) })).toBe("expired");
    expect(challengeState({ ...base, windowOpen: true, myAnswer: "accepted" })).toBe("accepted");
  });
  it("live and finished; cancelled by its ending, else by the challenger", () => {
    expect(challengeState({ ...base, partyStatus: "live", myAnswer: "accepted" })).toBe("live");
    expect(challengeState({ ...base, partyStatus: "finished", myAnswer: null })).toBe("finished");
    expect(challengeState({ ...base, partyStatus: "cancelled", ending: "declined" })).toBe("declined");
    expect(challengeState({ ...base, partyStatus: "cancelled", ending: "expired" })).toBe("expired");
    expect(challengeState({ ...base, partyStatus: "cancelled" })).toBe("cancelled");
  });
  it("the viewer's own decline or expired invite wins, whatever the others did", () => {
    expect(challengeState({ ...base, windowOpen: true, myAnswer: "declined" })).toBe("declined");
    expect(challengeState({ ...base, partyStatus: "live", myAnswer: "expired" })).toBe("expired");
  });
});
