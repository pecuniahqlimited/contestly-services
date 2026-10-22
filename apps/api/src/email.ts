/**
 * Sending mail from the API: the admin's primary provider, once on the other if it fails, and every
 * send logged with who delivered. Keys and the sender address come from env (packages/email).
 */
import { currentEmailConfig, logEmailSend } from "@contestly/db";
import { EMAIL_CODE_TTL_SECONDS } from "@contestly/shared";
import { sendersFromEnv, sendWithFallback, signInCodeEmail, type SendOutcome } from "@contestly/email";
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
