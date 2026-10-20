import { describe, expect, it } from "vitest";
import { mentionedHandles, splitMentions } from "@contestly/shared";

describe("mentionedHandles", () => {
  it("finds each handle once, lowercased", () => {
    expect(mentionedHandles("@Kemz and @ada.o, then @kemz again")).toEqual(["kemz", "ada.o"]);
  });
  it("leaves a sentence's full stop off the handle", () => {
    expect(mentionedHandles("Watch out @kemz.")).toEqual(["kemz"]);
  });
  it("ignores a bare @ and plain text", () => {
    expect(mentionedHandles("meet @ 5, no tags here")).toEqual([]);
  });
});

describe("splitMentions", () => {
  it("puts the tokens at the odd indices", () => {
    expect(splitMentions("hi @ada.o!")).toEqual(["hi ", "@ada.o", "!"]);
  });
});
