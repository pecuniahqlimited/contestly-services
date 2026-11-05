import { describe, expect, it } from "vitest";
import { HiddenAuthors } from "../src/hiddenAuthors.js";

describe("HiddenAuthors", () => {
  it("hides a hidden author's lines from that viewer only, never system lines or your own", async () => {
    const h = new HiddenAuthors(async (id) => new Set(id === "ada" ? ["kemi"] : []));
    expect(await h.sees("ada", "kemi")).toBe(false);
    expect(await h.sees("zee", "kemi")).toBe(true);
    expect(await h.sees("ada", null)).toBe(true);
    expect(await h.sees("kemi", "kemi")).toBe(true);
  });

  it("reloads after a forget, and after a while anyway", async () => {
    let blocked = new Set<string>();
    let loads = 0;
    let t = 0;
    const h = new HiddenAuthors(async () => { loads++; return blocked; }, () => t);
    expect(await h.sees("ada", "kemi")).toBe(true);
    blocked = new Set(["kemi"]);
    expect(await h.sees("ada", "kemi")).toBe(true); // cached
    h.forget(["ada"]);
    expect(await h.sees("ada", "kemi")).toBe(false);
    blocked = new Set();
    t += 31_000;
    expect(await h.sees("ada", "kemi")).toBe(true);
    expect(loads).toBe(3);
  });
});
