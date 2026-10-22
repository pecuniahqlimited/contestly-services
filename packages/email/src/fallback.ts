import { backupOf, type EmailProviderName } from "@contestly/shared";
import type { EmailMessage, EmailSender } from "./types.js";

export interface SendAttempt { provider: EmailProviderName; ok: boolean; error?: string }
export interface SendOutcome { deliveredBy: EmailProviderName | null; attempts: SendAttempt[] }

/**
 * Send with the primary; if it fails (or isn't configured), once with the other. Never throws: the
 * outcome says who delivered (null if neither did) and why each attempt failed, for the caller to log.
 */
export async function sendWithFallback(senders: Partial<Record<EmailProviderName, EmailSender>>, primary: EmailProviderName, message: EmailMessage): Promise<SendOutcome> {
  const attempts: SendAttempt[] = [];
  for (const provider of [primary, backupOf(primary)]) {
    const sender = senders[provider];
    if (!sender) {
      attempts.push({ provider, ok: false, error: "not configured" });
      continue;
    }
    try {
      await sender.send(message);
      attempts.push({ provider, ok: true });
      return { deliveredBy: provider, attempts };
    } catch (e) {
      attempts.push({ provider, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { deliveredBy: null, attempts };
}
