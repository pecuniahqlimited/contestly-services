import { describe, expect, it } from "vitest";
import { MessageCap, messageCapFromEnv } from "../src/messageCap.js";

const cfg = { perSecond: 3, disconnectAfterSeconds: 2 };
const send = (cap: MessageCap, n: number, at: number) => Array.from({ length: n }, () => cap.check(at).kind);

describe("MessageCap", () => {
  it("lets the cap through each second and drops the rest, logging once per burst", () => {
    const cap = new MessageCap(cfg);
    expect(send(cap, 3, 0)).toEqual(["ok", "ok", "ok"]);
    expect(cap.check(10)).toEqual({ kind: "drop", firstInBurst: true });
    expect(cap.check(20)).toEqual({ kind: "drop", firstInBurst: false });
    expect(send(cap, 3, 1000)).toEqual(["ok", "ok", "ok"]); // a new second
  });

  it("a quiet second ends the burst: a later burst logs again and starts its own clock", () => {
    const cap = new MessageCap(cfg);
    send(cap, 4, 0); // over
    send(cap, 2, 1000); // under: burst over
    expect(send(cap, 3, 2000)).toEqual(["ok", "ok", "ok"]);
    expect(cap.check(2001)).toEqual({ kind: "drop", firstInBurst: true });
  });

  it("disconnects only after staying over for the whole period", () => {
    const cap = new MessageCap(cfg);
    send(cap, 3, 0);
    expect(cap.check(0).kind).toBe("drop"); // over from t=0
    send(cap, 3, 1000);
    expect(cap.check(1000).kind).toBe("drop"); // still over, 1 s in
    send(cap, 3, 2000);
    expect(cap.check(2000)).toEqual({ kind: "disconnect", overForMs: 2000 });
  });

  it("a long gap is a fresh start", () => {
    const cap = new MessageCap(cfg);
    send(cap, 4, 0);
    expect(send(cap, 4, 5000)).toEqual(["ok", "ok", "ok", "drop"]);
    expect(cap.check(5001)).toEqual({ kind: "drop", firstInBurst: false });
  });

  it("reads its config from the environment with defaults", () => {
    expect(messageCapFromEnv({})).toEqual({ perSecond: 20, disconnectAfterSeconds: 5 });
    expect(messageCapFromEnv({ ROOM_MESSAGES_PER_SECOND: "50", ROOM_FLOOD_DISCONNECT_SECONDS: "10" })).toEqual({ perSecond: 50, disconnectAfterSeconds: 10 });
    expect(() => messageCapFromEnv({ ROOM_MESSAGES_PER_SECOND: "0" })).toThrow();
  });
});
