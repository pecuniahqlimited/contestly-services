/** ZeptoMail (Zoho) transactional API: https://www.zoho.com/zeptomail/help/api/email-sending.html */
import type { EmailFrom, EmailMessage, EmailSender } from "./types.js";
import { postJson } from "./http.js";

export function zeptoMailSender(opts: { token: string; from: EmailFrom; apiUrl?: string }): EmailSender {
  const url = opts.apiUrl ?? "https://api.zeptomail.com/v1.1/email";
  // The token is shown in ZeptoMail as "Zoho-enczapikey …"; accept it with or without the prefix.
  const auth = opts.token.startsWith("Zoho-enczapikey") ? opts.token : `Zoho-enczapikey ${opts.token}`;
  return {
    name: "zeptomail",
    send: (m: EmailMessage) => postJson(url, { authorization: auth }, {
      from: { address: opts.from.address, name: opts.from.name },
      to: [{ email_address: { address: m.to } }],
      subject: m.subject, textbody: m.text, htmlbody: m.html,
    }),
  };
}
