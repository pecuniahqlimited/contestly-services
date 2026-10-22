/** Brevo transactional API: https://developers.brevo.com/reference/sendtransacemail */
import type { EmailFrom, EmailMessage, EmailSender } from "./types.js";
import { postJson } from "./http.js";

export function brevoSender(opts: { apiKey: string; from: EmailFrom; apiUrl?: string }): EmailSender {
  const url = opts.apiUrl ?? "https://api.brevo.com/v3/smtp/email";
  return {
    name: "brevo",
    send: (m: EmailMessage) => postJson(url, { "api-key": opts.apiKey }, {
      sender: { email: opts.from.address, name: opts.from.name },
      to: [{ email: m.to }],
      subject: m.subject, textContent: m.text, htmlContent: m.html,
    }),
  };
}
