import { describe, expect, it } from "vitest";
import { chatRateCheck, type WindowCounter } from "../src/chatRate.js";

/** Fixed windows on a fake clock: a window starts with its first hit and lasts its length. */
function fakeCounter() {
  let now = 0;
  const windows = new Map<string, { count: number; endsAt: number }>();
  const counter: WindowCounter = {
    async hit(key, seconds) {
      let w = windows.get(key);
      if (!w || w.endsAt <= now) windows.set(key, (w = { count: 0, endsAt: now + seconds }));
      w.count++;
      return { count: w.count, ttlSeconds: w.endsAt - now };
    },
  };
  return { counter, tick: (s: number) => (now += s) };
}

const cfg = { burstMax: 3, burstSeconds: 10, hourlyMax: 5 };

describe("chatRateCheck", () => {
  it("allows a burst up to the limit, then says how long to wait", async () => {
    const { counter, tick } = fakeCounter();
    for (let i = 0; i < 3; i++) expect(await chatRateCheck(counter, "u", cfg)).toBeNull();
    tick(4);
    expect(await chatRateCheck(counter, "u", cfg)).toEqual({ retryAfter: 6 });
  });
  it("opens again when the burst window ends, until the hourly cap", async () => {
    const { counter, tick } = fakeCounter();
    for (let i = 0; i < 3; i++) await chatRateCheck(counter, "u", cfg);
    tick(10);
    expect(await chatRateCheck(counter, "u", cfg)).toBeNull();
    expect(await chatRateCheck(counter, "u", cfg)).toBeNull();
    const refused = await chatRateCheck(counter, "u", cfg);
    expect(refused?.retryAfter).toBe(3590);
  });
  it("counts each user apart", async () => {
    const { counter } = fakeCounter();
    for (let i = 0; i < 3; i++) await chatRateCheck(counter, "a", cfg);
    expect(await chatRateCheck(counter, "b", cfg)).toBeNull();
  });
});
