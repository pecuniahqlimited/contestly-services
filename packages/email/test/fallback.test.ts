import { describe, expect, it } from "vitest";
import { sendWithFallback, type EmailSender } from "../src/index.js";

const msg = { to: "a@b.co", subject: "s", text: "t", html: "h" };
const ok = (name: "zeptomail" | "brevo", sent: string[]): EmailSender => ({ name, send: async () => { sent.push(name); } });
const broken = (name: "zeptomail" | "brevo"): EmailSender => ({ name, send: async () => { throw new Error("503 down"); } });

describe("sendWithFallback", () => {
  it("uses the primary when it works", async () => {
    const sent: string[] = [];
    const out = await sendWithFallback({ zeptomail: ok("zeptomail", sent), brevo: ok("brevo", sent) }, "zeptomail", msg);
    expect(out.deliveredBy).toBe("zeptomail");
    expect(sent).toEqual(["zeptomail"]);
  });
  it("retries once on the other provider and records why the first failed", async () => {
    const sent: string[] = [];
    const out = await sendWithFallback({ zeptomail: broken("zeptomail"), brevo: ok("brevo", sent) }, "zeptomail", msg);
    expect(out.deliveredBy).toBe("brevo");
    expect(out.attempts).toEqual([{ provider: "zeptomail", ok: false, error: "503 down" }, { provider: "brevo", ok: true }]);
  });
  it("falls back when the primary isn't configured", async () => {
    const out = await sendWithFallback({ zeptomail: ok("zeptomail", []) }, "brevo", msg);
    expect(out.deliveredBy).toBe("zeptomail");
    expect(out.attempts[0]).toEqual({ provider: "brevo", ok: false, error: "not configured" });
  });
  it("reports nobody delivered when both fail, without throwing", async () => {
    const out = await sendWithFallback({ zeptomail: broken("zeptomail"), brevo: broken("brevo") }, "brevo", msg);
    expect(out.deliveredBy).toBeNull();
    expect(out.attempts.map((a) => a.provider)).toEqual(["brevo", "zeptomail"]);
  });
});
