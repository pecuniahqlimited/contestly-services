import { describe, expect, it } from "vitest";
import {
  DEFAULT_CORNER_UNLOCK, FILLING_UP_SHARE, FILLING_UP_WITHIN_MINUTES, clusteredPlayers, isFillingUp, newPlayerVerdict, partiesTabOrder, partyCountsForCorner, unlockProgress,
} from "../src/index.js";

const cfg = DEFAULT_CORNER_UNLOCK; // P 5, R 4, D 20, N 5
const met = { partiesHosted: 5, distinctPlayers: 20, newPlayers: 5 };

describe("unlockProgress", () => {
  it("unlocks only when all of P, D and N are met, each at exactly its threshold", () => {
    expect(unlockProgress(met, cfg).allMet).toBe(true);
    const p = unlockProgress(met, cfg).thresholds;
    expect([p.partiesHosted, p.distinctPlayers, p.newPlayers].every((t) => t.met && t.have === t.need)).toBe(true);
  });
  it.each([["partiesHosted"], ["distinctPlayers"], ["newPlayers"]] as const)("one short on %s keeps it locked", (key) => {
    const progress = unlockProgress({ ...met, [key]: met[key] - 1 }, cfg);
    expect(progress.allMet).toBe(false);
    expect(progress.thresholds[key]).toEqual({ need: met[key], have: met[key] - 1, met: false });
  });
  it("more than enough is still met", () => expect(unlockProgress({ partiesHosted: 9, distinctPlayers: 40, newPlayers: 12 }, cfg).allMet).toBe(true));
  it("N of 0 in config needs no new players", () => expect(unlockProgress({ ...met, newPlayers: 0 }, { ...cfg, newPlayers: 0 }).allMet).toBe(true));
});

describe("the R rule", () => {
  it("counts a party with R real players or more, never fewer", () => {
    expect(partyCountsForCorner(cfg.realPlayersPerParty, cfg)).toBe(true);
    expect(partyCountsForCorner(cfg.realPlayersPerParty + 10, cfg)).toBe(true);
    expect(partyCountsForCorner(cfg.realPlayersPerParty - 1, cfg)).toBe(false);
    expect(partyCountsForCorner(0, cfg)).toBe(false);
  });
});

describe("newPlayerVerdict", () => {
  const ok = { emailVerified: true, hasInstallId: true, installSeenOnAnotherAccount: false };
  it("counts with a verified email and an install id no other account has", () => expect(newPlayerVerdict(ok)).toEqual({ counts: true }));
  it("doesn't count without a verified email", () => expect(newPlayerVerdict({ ...ok, emailVerified: false })).toEqual({ counts: false, reason: "email_not_verified" }));
  it("doesn't count with no install id", () => expect(newPlayerVerdict({ ...ok, hasInstallId: false })).toEqual({ counts: false, reason: "no_install_id" }));
  it("doesn't count when the install id was seen on another account", () =>
    expect(newPlayerVerdict({ ...ok, installSeenOnAnotherAccount: true })).toEqual({ counts: false, reason: "install_seen_on_another_account" }));
  it("names the email first when several fail", () => expect(newPlayerVerdict({ emailVerified: false, hasInstallId: false, installSeenOnAnotherAccount: true })).toMatchObject({ reason: "email_not_verified" }));
});

describe("clusteredPlayers", () => {
  const s = (userId: string, kind: string, value: string) => ({ userId, kind, value });
  it("finds new players sharing an IP or install with each other", () => {
    expect(clusteredPlayers(["a", "b", "c"], "h", [s("a", "ip", "1.1.1.1"), s("b", "ip", "1.1.1.1"), s("c", "ip", "2.2.2.2")])).toEqual(["a", "b"]);
  });
  it("finds new players sharing with the host, never listing the host", () => {
    expect(clusteredPlayers(["a", "b"], "h", [s("h", "install", "x"), s("a", "install", "x"), s("b", "ip", "9.9.9.9")])).toEqual(["a"]);
  });
  it("doesn't match an IP against an install id with the same text", () => {
    expect(clusteredPlayers(["a", "b"], "h", [s("a", "ip", "same"), s("b", "install", "same")])).toEqual([]);
  });
  it("ignores people outside the unlock", () => expect(clusteredPlayers(["a"], "h", [s("a", "ip", "1"), s("z", "ip", "1")])).toEqual([]));
});

describe("partiesTabOrder (interim, until row 7)", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  const at = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();
  const card = (id: string, min: number, players: number, max = 10, status = "open") => ({ id, status, startsAt: at(min), playerCount: players, maxPlayers: max });

  it("pins parties over 60% full and starting within the hour, then the rest by starting soonest", () => {
    const cards = [card("later", 120, 9), card("soon_empty", 10, 1), card("filling_late", 50, 7), card("filling_soon", 20, 8), card("live", -5, 3, 10, "live")];
    expect(partiesTabOrder(cards, now).map((c) => c.id)).toEqual(["filling_soon", "filling_late", "live", "soon_empty", "later"]);
  });
  it("needs more than FILLING_UP_SHARE full and no more than FILLING_UP_WITHIN_MINUTES away", () => {
    expect(isFillingUp(card("x", 30, FILLING_UP_SHARE * 10), now)).toBe(false);
    expect(isFillingUp(card("x", FILLING_UP_WITHIN_MINUTES, 7), now)).toBe(true);
    expect(isFillingUp(card("x", FILLING_UP_WITHIN_MINUTES + 1, 7), now)).toBe(false);
    expect(isFillingUp(card("x", -1, 9, 10, "live"), now)).toBe(false);
  });
  it("accepts Date start times too (the API's cards before they're sent)", () => {
    expect(partiesTabOrder([{ ...card("a", 30, 0), startsAt: new Date(at(30)) }, { ...card("b", 5, 0), startsAt: new Date(at(5)) }], now).map((c) => c.id)).toEqual(["b", "a"]);
  });
});
