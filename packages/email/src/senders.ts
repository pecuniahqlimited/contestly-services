/**
 * The configured providers, from env. EMAIL_TRANSPORT=mailpit (dev) sends every provider's mail to
 * Mailpit instead. A provider whose key is missing simply isn't there, and the fallback skips it.
 */
import type { EmailProviderName } from "@contestly/shared";
import type { EmailFrom, EmailSender } from "./types.js";
import { zeptoMailSender } from "./zeptomail.js";
import { brevoSender } from "./brevo.js";
import { mailpitSender } from "./mailpit.js";

export interface SenderOptions {
  /** Dev only: true when this provider should fail (the onboarding sim's fallback check). */
  devShouldFail?: (provider: EmailProviderName) => Promise<boolean>;
}

export function sendersFromEnv(env: NodeJS.ProcessEnv, opts: SenderOptions = {}): Partial<Record<EmailProviderName, EmailSender>> {
  const from: EmailFrom = { address: env.EMAIL_FROM_ADDRESS ?? "", name: env.EMAIL_FROM_NAME ?? "Contestly" };
  if (env.EMAIL_TRANSPORT === "mailpit") {
    if (env.NODE_ENV === "production") throw new Error("EMAIL_TRANSPORT=mailpit is for local work only");
    const url = env.MAILPIT_URL ?? "http://localhost:8025";
    const dev = (name: EmailProviderName) => mailpitSender({ name, url, from: { ...from, address: from.address || "codes@contestly.local" }, shouldFail: () => opts.devShouldFail?.(name) ?? Promise.resolve(false) });
    return { zeptomail: dev("zeptomail"), brevo: dev("brevo") };
  }
  const senders: Partial<Record<EmailProviderName, EmailSender>> = {};
  if (env.ZEPTOMAIL_TOKEN && from.address) senders.zeptomail = zeptoMailSender({ token: env.ZEPTOMAIL_TOKEN, from });
  if (env.BREVO_API_KEY && from.address) senders.brevo = brevoSender({ apiKey: env.BREVO_API_KEY, from });
  return senders;
}
