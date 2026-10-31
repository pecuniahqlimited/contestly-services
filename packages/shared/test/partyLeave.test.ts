import { describe, expect, it } from "vitest";
import { PARTY_LEAVE_LOCK_SECONDS, leaveWindow } from "../src/index.js";

const now = new Date("2026-10-29T12:00:00Z");
const at = (secondsFromNow: number) => new Date(now.getTime() + secondsFromNow * 1000);

describe("leaveWindow", () => {
  it("is open while the party is open and more than the lock away", () => {
    expect(leaveWindow({ status: "open", startsAt: at(PARTY_LEAVE_LOCK_SECONDS + 1) }, now)).toBe("open");
    expect(leaveWindow({ status: "open", startsAt: at(3600).toISOString() }, now)).toBe("open");
  });
  it("locks at exactly the lock, inside it, past the start, and once live", () => {
    expect(leaveWindow({ status: "open", startsAt: at(PARTY_LEAVE_LOCK_SECONDS) }, now)).toBe("locked");
    expect(leaveWindow({ status: "open", startsAt: at(60) }, now)).toBe("locked");
    expect(leaveWindow({ status: "open", startsAt: at(-30) }, now)).toBe("locked");
    expect(leaveWindow({ status: "live", startsAt: at(3600) }, now)).toBe("locked");
  });
  it("is closed once finished or cancelled, whenever it was due", () => {
    expect(leaveWindow({ status: "finished", startsAt: at(3600) }, now)).toBe("closed");
    expect(leaveWindow({ status: "cancelled", startsAt: at(3600) }, now)).toBe("closed");
  });
});

describe("stallThresholdSeconds", () => {
  it("is one whole question cycle plus the grace", async () => {
    const { DEFAULT_PARTY_CONFIG, stallThresholdSeconds } = await import("../src/index.js");
    expect(stallThresholdSeconds(20, DEFAULT_PARTY_CONFIG)).toBe(20 + 6 + 7 + 30);
    expect(stallThresholdSeconds(5, { revealSeconds: 3, standingsSeconds: 2, stallGraceSeconds: 10 })).toBe(20);
  });
});
