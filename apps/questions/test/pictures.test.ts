import { describe, expect, it } from "vitest";
import { pictureLimit, pictureRoom, withinPictureCap } from "../src/pipeline/pictures.js";
import { planBatches } from "../src/providers/drafting/generator.js";

const pic = (image: string) => ({ format: "picture", payload: { imageUrl: `pool/${image}.jpg` } });
const text = (n: number) => ({ format: "pick_one", payload: { question: `q${n}` } });

describe("picture cap", () => {
  it("a quarter of the play order, rounded down, never more than the pool has images", () => {
    expect(pictureLimit(10, 7)).toBe(2);
    expect(pictureLimit(1, 7)).toBe(0);
    expect(pictureLimit(3, 7)).toBe(0);
    expect(pictureLimit(4, 7)).toBe(1);
    expect(pictureLimit(33, 7)).toBe(7);
    expect(pictureLimit(0, 7)).toBe(0);
    expect(pictureLimit(10, 0)).toBe(0);
  });

  it("keeps every other format, and pictures while there's room and the image is new", () => {
    const items = [pic("a"), text(1), pic("a"), pic("b"), text(2), pic("c")];
    const { kept, dropped, room } = withinPictureCap(items, { left: 2, usedImages: new Set() });
    expect(kept).toEqual([pic("a"), text(1), pic("b"), text(2)]);
    expect(dropped).toBe(2);
    expect(room.left).toBe(0);
  });

  it("counts what's already in the set, without changing the caller's room", () => {
    const room = pictureRoom([pic("a"), text(1)], 2);
    expect(room.left).toBe(1);
    const { kept } = withinPictureCap([pic("a"), pic("b"), pic("c")], room);
    expect(kept).toEqual([pic("b")]);
    expect(room.left).toBe(1);
    expect([...room.usedImages]).toEqual(["pool/a.jpg"]);
  });
});

describe("planBatches with a cap", () => {
  it("gives a capped format's excess to the others", () => {
    expect(planBatches(10, ["pick_one", "picture"], { picture: 2 })).toEqual([{ format: "pick_one", count: 8 }, { format: "picture", count: 2 }]);
  });

  it("asks for less when every format is capped, and skips a format capped at zero", () => {
    expect(planBatches(30, ["picture"], { picture: 7 })).toEqual([{ format: "picture", count: 7 }]);
    expect(planBatches(5, ["picture", "order"], { picture: 0 })).toEqual([{ format: "order", count: 5 }]);
    expect(planBatches(5, ["picture"], { picture: 0 })).toEqual([]);
  });
});

describe("draftAndJudge under the picture cap", () => {
  it("drops pictures over the cap or repeating an image before they're verified, and stops asking once it's full", async () => {
    const { draftAndJudge } = await import("../src/pipeline/judge.js");
    const { buildSpec } = await import("../src/pipeline/spec.js");
    const { mockEmbedder } = await import("../src/providers/mock/embedder.js");
    const { mockSafety } = await import("../src/providers/mock/safety.js");
    const sources = [{ id: "c0", text: "Zuma Rock is near Abuja. Olumo Rock is in Abeokuta." }];
    const spec = buildSpec({ brief: "rocks", difficulty: "mixed", formats: ["picture", "pick_one"], questionCount: 4, questionSeconds: 10, fileIds: ["f"] });
    const picture = (image: string, n: number) => ({
      format: "picture" as const, claim: `claim ${image} ${n}`, sourceChunkId: "c0",
      payload: { question: `Which rock is this? (${image} ${n})`, imageUrl: `pool/${image}.jpg`, imageAlt: "a rock", options: ["Zuma Rock", "Olumo Rock", "Aso Rock", "Idanre Hill"], correctIndex: 0 },
    });
    const asked: { count: number; formats: string[]; maxPicture?: number }[] = [];
    const generator = {
      draft: async (input: { spec: { formats: string[] }; count: number; maxPerFormat?: { picture?: number } }) => {
        asked.push({ count: input.count, formats: input.spec.formats, maxPicture: input.maxPerFormat?.picture });
        return input.spec.formats.includes("picture") ? [picture("zuma", 1), picture("zuma", 2), picture("olumo", 3), picture("aso", 4)] : [];
      },
    };
    const verified: string[] = [];
    const verifier = { name: "count", verify: async (q: { payload: unknown }) => { verified.push(String((q.payload as { imageUrl?: string }).imageUrl)); return { verdict: "correct" as const, sources: ["chunk:c0"] }; } };
    const r = await draftAndJudge({
      spec, providers: { generator, verifier, embedder: mockEmbedder, safety: mockSafety }, dedupeSimilarity: 0.99, want: 4, avoid: [], sources,
      pictures: { limit: 2, inSet: [] },
    });
    expect(verified).toEqual(["pool/zuma.jpg", "pool/olumo.jpg"]); // the second zuma and the over-cap aso were never verified
    expect(asked[0].maxPicture).toBe(2);
    expect(r.accepted.filter((a) => a.draft.format === "picture").length).toBeLessThanOrEqual(2);
    // Round two: the cap is full, so pictures aren't asked for at all.
    if (asked[1]) expect(asked[1].formats).toEqual(["pick_one"]);
  });
});
