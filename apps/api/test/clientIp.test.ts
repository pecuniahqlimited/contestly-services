import { describe, expect, it } from "vitest";
import { CLOUDFLARE_RANGES, addressSet, clientIpResolver } from "../src/clientIp.js";

const CADDY = "172.18.0.2";
const CF_EDGE = "162.158.10.20"; // inside 162.158.0.0/15
const CLIENT = "41.58.100.7";
const resolve = clientIpResolver({ trustedProxies: [CADDY], cloudflare: CLOUDFLARE_RANGES });

describe("clientIpResolver", () => {
  it("Cloudflare → Caddy → API: the client from CF-Connecting-IP", () => {
    expect(resolve(CADDY, { "x-forwarded-for": CF_EDGE, "cf-connecting-ip": CLIENT })).toBe(CLIENT);
    expect(resolve(`::ffff:${CADDY}`, { "x-forwarded-for": `1.2.3.4, ${CF_EDGE}`, "cf-connecting-ip": CLIENT })).toBe(CLIENT); // only Caddy's own hop counts
  });
  it("Cloudflare straight to the API: the client from CF-Connecting-IP", () => {
    expect(resolve(CF_EDGE, { "cf-connecting-ip": CLIENT })).toBe(CLIENT);
    expect(resolve("2606:4700::1", { "cf-connecting-ip": "2c0f:f4c0::5" })).toBe("2c0f:f4c0::5");
  });
  it("Caddy reached without Cloudflare: what Caddy saw, never the header", () => {
    expect(resolve(CADDY, { "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": CLIENT })).toBe("203.0.113.9");
  });
  it("anyone else sending the header: the socket address", () => {
    expect(resolve("203.0.113.9", { "cf-connecting-ip": CLIENT, "x-forwarded-for": CF_EDGE })).toBe("203.0.113.9");
    expect(resolve("::ffff:203.0.113.9", {})).toBe("203.0.113.9");
  });
  it("junk in the headers falls back to what's provable", () => {
    expect(resolve(CF_EDGE, { "cf-connecting-ip": "not-an-ip" })).toBe(CF_EDGE);
    expect(resolve(CADDY, { "x-forwarded-for": "garbage", "cf-connecting-ip": CLIENT })).toBe(CADDY);
    expect(resolve(CADDY, {})).toBe(CADDY);
  });
  it("trusts nothing by default (no proxies configured)", () => {
    const local = clientIpResolver({ trustedProxies: [""], cloudflare: CLOUDFLARE_RANGES });
    expect(local("127.0.0.1", { "cf-connecting-ip": CLIENT, "x-forwarded-for": CF_EDGE })).toBe("127.0.0.1");
  });
});

describe("addressSet", () => {
  it("matches addresses and ranges, IPv4 and IPv6, and refuses junk config", () => {
    const has = addressSet(["10.0.0.5", "172.16.0.0/12", "2a06:98c0::/29"]);
    expect([has("10.0.0.5"), has("10.0.0.6"), has("172.31.255.1"), has("::ffff:172.20.0.1"), has("2a06:98c1::1"), has(undefined)]).toEqual([true, false, true, true, true, false]);
    expect(() => addressSet(["not-an-ip/8"])).toThrow();
  });
});
