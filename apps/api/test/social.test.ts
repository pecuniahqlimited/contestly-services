import { describe, expect, it } from "vitest";
import { MAX_FRIENDS_NAMED, MAX_PARTY_FACES, MY_RECENT_DAYS, MY_RECENT_LIMIT, type Person } from "@contestly/shared";
import { groupMyParties, headToHead, pickPartyPeople } from "../src/social.js";

const person = (id: string): Person => ({ id, handle: id, displayName: id, avatarEmoji: "😎", isVerified: false });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("pickPartyPeople", () => {
  const players = ["a", "b", "host", "c", "d", "e"].map(person);

  it("puts the host's face first, then join order, capped", () => {
    const { faces } = pickPartyPeople(players, "host", new Set());
    expect(ids(faces)).toEqual(["host", "a", "b", "c"].slice(0, MAX_PARTY_FACES));
  });

  it("leaves the host out when they don't play", () => {
    expect(ids(pickPartyPeople(players, "nobody", new Set()).faces)[0]).toBe("a");
  });

  it("names the first people the viewer follows and counts them all, never the viewer", () => {
    const { friendsIn } = pickPartyPeople(players, "host", new Set(["c", "e", "b", "me"]), "b");
    expect(friendsIn.count).toBe(2);
    expect(ids(friendsIn.people)).toEqual(["c", "e"].slice(0, MAX_FRIENDS_NAMED));
  });

  it("counts past the named few", () => {
    const { friendsIn } = pickPartyPeople(players, "host", new Set(["a", "b", "c", "d"]));
    expect(friendsIn.people).toHaveLength(MAX_FRIENDS_NAMED);
    expect(friendsIn.count).toBe(4);
  });
});

describe("headToHead", () => {
  it("counts who placed above whom; ties for neither", () => {
    expect(headToHead([{ myRank: 1, theirRank: 3 }, { myRank: 4, theirRank: 2 }, { myRank: 2, theirRank: 2 }, { myRank: 1, theirRank: 2 }])).toEqual({ me: 2, them: 1, played: 4 });
  });

  it("leaves out a party either didn't get a rank in", () => {
    expect(headToHead([{ myRank: null, theirRank: 1 }, { myRank: 2, theirRank: null }])).toEqual({ me: 0, them: 0, played: 0 });
  });

  it("starts at nothing", () => expect(headToHead([])).toEqual({ me: 0, them: 0, played: 0 }));
});

describe("groupMyParties", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
  const DAY = 24 * 60;
  const p = (id: string, status: "open" | "live" | "finished" | "cancelled", startsIn: number, role: "hosting" | "playing" | "invited" = "playing", endedIn: number | null = null) =>
    ({ id, status, role, startsAt: at(startsIn), endedAt: endedIn === null ? null : at(endedIn) });

  it("sorts each group and keeps invites apart", () => {
    const g = groupMyParties([
      p("later", "open", 90), p("soon", "open", 5, "hosting"), p("live", "live", -3),
      p("inv-later", "open", 60, "invited"), p("inv-soon", "open", 10, "invited"), p("inv-live", "live", -1, "invited"),
      p("old", "finished", -3 * DAY, "playing", -3 * DAY + 5), p("new", "finished", -60, "playing", -50), p("off", "cancelled", -30, "hosting", -30),
    ], now);
    expect(ids(g.invited)).toEqual(["inv-soon", "inv-later"]);
    expect(ids(g.live)).toEqual(["live"]);
    expect(ids(g.upcoming)).toEqual(["soon", "later"]);
    expect(ids(g.recent)).toEqual(["off", "new", "old"]);
  });

  it("drops recent parties past the window, counting from the start when the end wasn't recorded", () => {
    const g = groupMyParties([p("edge", "finished", -(MY_RECENT_DAYS * DAY) + 1), p("gone", "finished", -(MY_RECENT_DAYS * DAY) - 1), p("ended-in", "finished", -(MY_RECENT_DAYS + 1) * DAY, "playing", -DAY)], now);
    expect(ids(g.recent)).toEqual(["ended-in", "edge"]);
  });

  it("caps recent", () => {
    const many = Array.from({ length: MY_RECENT_LIMIT + 5 }, (_, i) => p(`r${i}`, "finished", -i - 1));
    expect(groupMyParties(many, now).recent).toHaveLength(MY_RECENT_LIMIT);
  });
});
