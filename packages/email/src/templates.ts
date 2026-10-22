/** Mail copy lives in code: plain, short, and never about money. */
import type { EmailMessage } from "./types.js";

export function signInCodeEmail(to: string, code: string, ttlMinutes: number): EmailMessage {
  const text = `Your Contestly code is ${code}\n\nType it in the app to sign in. It works for ${ttlMinutes} minutes.\n\nIf you didn't ask for this, you can ignore this email.`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;color:#0B1B3F;line-height:1.5">
<p>Your Contestly code is</p>
<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:8px 0">${code}</p>
<p>Type it in the app to sign in. It works for ${ttlMinutes} minutes.</p>
<p style="color:#6B7A99;font-size:13px">If you didn't ask for this, you can ignore this email.</p>
</div>`;
  return { to, subject: `${code} is your Contestly code`, text, html };
}
