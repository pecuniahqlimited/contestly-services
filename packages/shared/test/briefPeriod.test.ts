import { describe, expect, it } from "vitest";
import { briefPeriod, isRecentPeriod, knownThroughYear, recentPeriodIn } from "../src/index.js";

const NOW = new Date("2026-11-16T12:00:00Z");
const period = (brief: string) => briefPeriod(brief, NOW);

describe("briefPeriod", () => {
  it("a year, a range, a season and a decade", () => {
    expect(period("WWE monday night raw 2026")).toEqual({ label: "2026", from: 2026, to: 2026 });
    expect(period("Attitude Era 1997-2001")).toEqual({ label: "1997–2001", from: 1997, to: 2001 });
    expect(period("Premier League 2025/26")).toEqual({ label: "2025–2026", from: 2025, to: 2026 });
    expect(period("Premier League 2025-26 season")).toEqual({ label: "2025–2026", from: 2025, to: 2026 });
    expect(period("Afrobeats from 2010 to 2015")).toEqual({ label: "2010–2015", from: 2010, to: 2015 });
    expect(period("1990s Nollywood")).toEqual({ label: "the 1990s", from: 1990, to: 1999 });
    expect(period("hits of the 90s")).toEqual({ label: "the 1990s", from: 1990, to: 1999 });
    expect(period("'80s cartoons")).toEqual({ label: "the 1980s", from: 1980, to: 1989 });
  });

  it("words that mean now are this year", () => {
    expect(period("the latest Afrobeats releases")).toEqual({ label: "this year", from: 2026, to: 2026 });
    expect(period("current affairs")).toEqual({ label: "this year", from: 2026, to: 2026 });
  });

  it("several mentions widen to cover them all", () => {
    expect(period("World Cups of 1994 and 2002")).toEqual({ label: "1994–2002", from: 1994, to: 2002 });
  });

  it("no period: ages, plain numbers and briefs without one", () => {
    expect(period("Tolu in her 30s: a birthday quiz")).toBeNull();
    expect(period("Jollof wars")).toBeNull();
    expect(period("100 questions about Lagos")).toBeNull();
  });
});

describe("recent periods", () => {
  it("recent when it ends inside the writers' knowledge lag (12 months)", () => {
    expect(isRecentPeriod({ label: "2026", from: 2026, to: 2026 }, NOW)).toBe(true);
    expect(isRecentPeriod({ label: "2025", from: 2025, to: 2025 }, NOW)).toBe(true);
    expect(isRecentPeriod({ label: "2024", from: 2024, to: 2024 }, NOW)).toBe(false);
    expect(isRecentPeriod({ label: "2025", from: 2025, to: 2025 }, new Date("2027-01-10T00:00:00Z"))).toBe(false);
  });

  it("known through the year before the lag began", () => {
    expect(knownThroughYear(NOW)).toBe(2024);
    expect(knownThroughYear(new Date("2027-01-10T00:00:00Z"))).toBe(2025);
  });

  it("recentPeriodIn: only a recent one", () => {
    expect(recentPeriodIn("WWE monday night raw 2026", NOW)?.label).toBe("2026");
    expect(recentPeriodIn("Attitude Era 1997-2001", NOW)).toBeNull();
    expect(recentPeriodIn("Jollof wars", NOW)).toBeNull();
  });
});
