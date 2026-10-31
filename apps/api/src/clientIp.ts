/**
 * The real client IP, for per-IP rate limits. Production is Cloudflare → Caddy → API, so the socket peer
 * is Caddy and the client is in CF-Connecting-IP. That header is trusted only when the request provably
 * came through Cloudflare:
 *
 * - the peer is a Cloudflare address (the API reached straight from Cloudflare), or
 * - the peer is a trusted proxy (Caddy, TRUSTED_PROXY_IPS) and the address Caddy saw, the last
 *   X-Forwarded-For entry, which Caddy writes itself and doesn't take from the client, is a Cloudflare address.
 *
 * Anything else gets the address that's provable: the socket peer, or what a trusted proxy saw. A header
 * from anyone else is ignored, so nobody picks their own rate-limit bucket.
 */
import { BlockList, isIP } from "node:net";
import type { FastifyRequest } from "fastify";

/** Cloudflare's published ranges (cloudflare.com/ips), the default for CLOUDFLARE_IPS. */
export const CLOUDFLARE_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];

/** "::ffff:1.2.3.4" (IPv4 on a dual-stack socket) → "1.2.3.4". */
const normalise = (ip: string) => (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip);

/** Addresses and CIDR ranges, matched with node's BlockList. */
export function addressSet(entries: readonly string[]) {
  const list = new BlockList();
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    const [addr, bits] = e.split("/");
    const family = isIP(addr) === 6 ? "ipv6" : "ipv4";
    if (!isIP(addr)) throw new Error(`not an IP address or range: ${e}`);
    if (bits === undefined) list.addAddress(addr, family);
    else list.addSubnet(addr, Number(bits), family);
  }
  return (ip: string | undefined) => {
    if (!ip) return false;
    const a = normalise(ip);
    const family = isIP(a);
    return family !== 0 && list.check(a, family === 6 ? "ipv6" : "ipv4");
  };
}

export interface TrustConfig {
  /** Caddy (or any proxy in front of the API that isn't Cloudflare). */
  trustedProxies: readonly string[];
  cloudflare: readonly string[];
}

export const trustConfigFromEnv = (env = process.env): TrustConfig => ({
  trustedProxies: (env.TRUSTED_PROXY_IPS ?? "").split(","),
  cloudflare: env.CLOUDFLARE_IPS ? env.CLOUDFLARE_IPS.split(",") : CLOUDFLARE_RANGES,
});

/** Builds the resolver once; call it per request with the peer address and the headers. */
export function clientIpResolver(cfg: TrustConfig) {
  const isProxy = addressSet(cfg.trustedProxies);
  const isCloudflare = addressSet(cfg.cloudflare);
  return (peer: string, headers: FastifyRequest["headers"]): string => {
    const socket = normalise(peer);
    const cf = typeof headers["cf-connecting-ip"] === "string" ? headers["cf-connecting-ip"].trim() : undefined;
    const viaCloudflare = (hop: string) => isCloudflare(hop) && cf && isIP(cf) ? normalise(cf) : undefined;
    if (isCloudflare(socket)) return viaCloudflare(socket) ?? socket;
    if (!isProxy(socket)) return socket;
    const xff = typeof headers["x-forwarded-for"] === "string" ? headers["x-forwarded-for"] : undefined;
    const seen = xff?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    if (!seen || !isIP(seen)) return socket;
    return viaCloudflare(seen) ?? normalise(seen);
  };
}
