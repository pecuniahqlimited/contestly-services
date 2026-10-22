/**
 * DEV ONLY: delivers to the local Mailpit container (inbox at :8025) under a provider's name, so the
 * fallback runs locally with no keys. The message carries X-Contestly-Provider so you can see which
 * one sent it. `shouldFail` lets the sim make one provider fail on purpose.
 */
import type { EmailProviderName } from "@contestly/shared";
import type { EmailFrom, EmailMessage, EmailSender } from "./types.js";
import { postJson } from "./http.js";

export const PROVIDER_HEADER = "X-Contestly-Provider";

export function mailpitSender(opts: { name: EmailProviderName; url: string; from: EmailFrom; shouldFail?: () => Promise<boolean> }): EmailSender {
  return {
    name: opts.name,
    async send(m: EmailMessage) {
      if (await opts.shouldFail?.()) throw new Error(`${opts.name} failing on purpose (dev)`);
      await postJson(`${opts.url.replace(/\/+$/, "")}/api/v1/send`, {}, {
        From: { Email: opts.from.address, Name: opts.from.name },
        To: [{ Email: m.to }],
        Subject: m.subject, Text: m.text, HTML: m.html,
        Headers: { [PROVIDER_HEADER]: opts.name },
      });
    },
  };
}
