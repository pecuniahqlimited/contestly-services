/** Server secrets for codes and phone hashes. Required in production (assertAuthConfig); fixed dev values otherwise. */
import { createHash, createHmac, randomBytes } from "node:crypto";

const secret = (name: "EMAIL_CODE_SECRET" | "PHONE_HASH_SECRET") => {
  const v = process.env[name];
  if (v) return v;
  if (process.env.NODE_ENV === "production") throw new Error(`${name} is not set`);
  return `dev-only-${name}`;
};

export const hmac = (name: "EMAIL_CODE_SECRET" | "PHONE_HASH_SECRET", value: string) => createHmac("sha256", secret(name)).update(value).digest("hex");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** base64url SHA-256: the PKCE S256 transform. */
export const s256 = (value: string) => createHash("sha256").update(value).digest("base64url");
/** A random URL-safe token of `bytes` bytes. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** What contact matching stores and compares: HMAC over the app's SHA-256 of the E.164 number. */
export const phoneHmac = (phoneSha256: string) => hmac("PHONE_HASH_SECRET", phoneSha256);
