import { describe, expect, it } from "vitest";
import { roomErrorSchema } from "@contestly/shared";
import { firstSighting, refusalMessage } from "../src/chat.js";

describe("firstSighting: a republished line reaches clients once", () => {
  it("passes a new id, drops a repeat, and forgets the oldest past the cap", () => {
    const first = firstSighting(3);
    expect(["a", "a", "b", "c"].map(first)).toEqual([true, false, true, true]);
    first("d"); // "a" falls out
    expect([first("a"), first("d")]).toEqual([true, false]);
  });
});

describe("refusalMessage: a refused line as MSG.error", () => {
  const refused = (code: string, details?: object) => Object.assign(new Error(code), { statusCode: 403, details });
  const id = "00000000-0000-4000-8000-000000000001";

  it("carries a chat timeout's end, as the HTTP refusal's details.until", () => {
    const until = "2026-11-06T12:00:00.000Z";
    const msg = refusalMessage(refused("chat_timeout", { until }), id);
    expect(msg).toEqual({ error: "chat_timeout", clientMsgId: id, until });
    expect(roomErrorSchema.parse(msg)).toEqual(msg);
  });

  it("leaves it out for every other refusal", () => {
    expect(refusalMessage(refused("cannot_message"), id)).toEqual({ error: "cannot_message", clientMsgId: id });
  });
});
