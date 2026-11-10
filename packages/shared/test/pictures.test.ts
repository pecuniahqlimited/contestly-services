import { describe, expect, it } from "vitest";
import { pictureCap, promotableReserve } from "../src/index.js";

const q = (format: string, id = format) => ({ id, format });

describe("the picture cap", () => {
  it("a quarter of the play order, rounded down, for every size", () => {
    expect([0, 1, 2, 3, 4, 5, 7, 8, 10, 12, 30].map(pictureCap)).toEqual([0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 7]);
  });

  it("a void promotes the first reserve, skipping pictures once the play order holds its cap", () => {
    const reserves = [q("picture", "r1"), q("pick_one", "r2")];
    expect(promotableReserve(reserves, [q("pick_one"), q("pick_one"), q("pick_one"), q("pick_one")], 4)?.id).toBe("r1");
    expect(promotableReserve(reserves, [q("picture"), q("pick_one"), q("pick_one"), q("pick_one")], 4)?.id).toBe("r2");
    expect(promotableReserve(reserves, [q("pick_one"), q("pick_one"), q("pick_one")], 3)?.id).toBe("r2");
    expect(promotableReserve([q("picture")], [q("pick_one")], 3)).toBeNull();
  });
});
