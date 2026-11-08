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

const wrap = (body: string) => `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;color:#0B1B3F;line-height:1.5">${body}</div>`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The code that verifies a brand's business email (ADR 0017): not a sign-in. */
export function businessEmailCodeEmail(to: string, code: string, ttlMinutes: number, brandName: string): EmailMessage {
  const text = `Your code is ${code}\n\nType it in Contestly to confirm this is ${brandName}'s business email. It works for ${ttlMinutes} minutes.\n\nIf you didn't ask for this, you can ignore this email.`;
  const html = wrap(`<p>Your code is</p>
<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:8px 0">${code}</p>
<p>Type it in Contestly to confirm this is ${escapeHtml(brandName)}'s business email. It works for ${ttlMinutes} minutes.</p>
<p style="color:#6B7A99;font-size:13px">If you didn't ask for this, you can ignore this email.</p>`);
  return { to, subject: `${code} confirms ${brandName}'s business email`, text, html };
}

/** An invite to a brand's team for someone who may not be on the app yet: sign up with this email to answer it. */
export function brandInviteEmail(to: string, brandName: string, inviterName: string, role: string, appUrl: string): EmailMessage {
  const text = `${inviterName} asked you to join ${brandName} on Contestly as ${role}.\n\nGet the app and sign in with this email (${to}) to accept: ${appUrl}\n\nIf you weren't expecting this, you can ignore this email.`;
  const html = wrap(`<p><b>${escapeHtml(inviterName)}</b> asked you to join <b>${escapeHtml(brandName)}</b> on Contestly as ${escapeHtml(role)}.</p>
<p>Get the app and sign in with this email (${escapeHtml(to)}) to accept.</p>
<p><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#0B1B3F;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none">Open Contestly</a></p>
<p style="color:#6B7A99;font-size:13px">If you weren't expecting this, you can ignore this email.</p>`);
  return { to, subject: `${inviterName} invited you to ${brandName} on Contestly`, text, html };
}
