import type { PushMessage, PushResult, PushSender } from "@contestly/db";

/**
 * Dev and tests: records what would have been sent (and logs it), sends nothing. A token starting with
 * "invalid" answers as FCM does for an unregistered one, so the clean-up path can be exercised end to end.
 */
export class LogPushSender implements PushSender {
  readonly name = "log";
  readonly sent: PushMessage[] = [];
  async send(message: PushMessage): Promise<PushResult> {
    if (message.token.startsWith("invalid")) return { ok: false, invalidToken: true, error: "not registered (log provider)" };
    this.sent.push(message);
    console.log(`[push:log] ${message.platform} …${message.token.slice(-6)}: "${message.title}" — ${message.body} → ${message.data.deepLink}`);
    return { ok: true };
  }
}
