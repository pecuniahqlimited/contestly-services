/**
 * Sending mail from the API: the admin's primary provider, once on the other if it fails, and every
 * send logged with who delivered. Keys and the sender address come from env (packages/email).
 */
import { currentEmailConfig, logEmailSend } from "@contestly/db";
import { EMAIL_CODE_TTL_SECONDS } from "@contestly/shared";
import { brandInviteEmail, businessEmailCodeEmail, sendersFromEnv, sendWithFallback, signInCodeEmail, type EmailMessage, type SendOutcome } from "@contestly/email";
import { valkey } from "./redis.js";

/** Dev only (Mailpit transport): the sim sets this key to make one provider fail. */
export const devEmailFailKey = (provider: string) => `dev:email:fail:${provider}`;

export const senders = sendersFromEnv(process.env, { devShouldFail: async (p) => (await valkey().exists(devEmailFailKey(p))) === 1 });

export async function sendSignInCode(to: string, code: string): Promise<SendOutcome> {
  const { primary } = await currentEmailConfig();
  const outcome = await sendWithFallback(senders, primary, signInCodeEmail(to, code, EMAIL_CODE_TTL_SECONDS / 60));
  await logEmailSend({ template: "sign_in_code", to, deliveredBy: outcome.deliveredBy, attempts: outcome.attempts });
  return outcome;
}

async function send(template: string, message: EmailMessage): Promise<SendOutcome> {
  const { primary } = await currentEmailConfig();
  const outcome = await sendWithFallback(senders, primary, message);
  await logEmailSend({ template, to: message.to, deliveredBy: outcome.deliveredBy, attempts: outcome.attempts });
  return outcome;
}

export const sendBusinessEmailCode = (to: string, code: string, brandName: string) =>
  send("brand_email_code", businessEmailCodeEmail(to, code, EMAIL_CODE_TTL_SECONDS / 60, brandName));

/** Where an emailed invite sends people: the web app (the store links live there). */
const appUrl = () => process.env.PUBLIC_WEB_URL ?? "https://play.contestlyapp.com";
export const sendBrandInvite = (to: string, brandName: string, inviterName: string, role: string) =>
  send("brand_invite", brandInviteEmail(to, brandName, inviterName, role, appUrl()));
