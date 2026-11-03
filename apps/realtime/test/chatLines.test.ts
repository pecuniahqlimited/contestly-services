import { describe, expect, it } from "vitest";
import { firstSighting } from "../src/chat.js";

describe("firstSighting: a republished line reaches clients once", () => {
  it("passes a new id, drops a repeat, and forgets the oldest past the cap", () => {
    const first = firstSighting(3);
    expect(["a", "a", "b", "c"].map(first)).toEqual([true, false, true, true]);
    first("d"); // "a" falls out
    expect([first("a"), first("d")]).toEqual([true, false]);
  });
});
