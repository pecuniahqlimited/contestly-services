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
