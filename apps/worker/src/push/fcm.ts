/**
 * FCM HTTP v1 through Firebase Admin: Android directly, iOS through APNs (the Capacitor shell's FCM plugin
 * registers APNs tokens with FCM), web through FCM's web push. Firebase types stay in this file.
 */
import type { PushMessage, PushResult, PushSender } from "@contestly/db";

/** FCM's answers that mean the token will never work again: clear it. */
const INVALID_TOKEN_CODES = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"]);
export const isInvalidTokenError = (code: string | undefined) => !!code && INVALID_TOKEN_CODES.has(code);

type Send = (message: object) => Promise<string>;

export class FcmPushSender implements PushSender {
  readonly name = "fcm";
  private sendFn?: Promise<Send>;
  constructor(private readonly projectId: string, private readonly serviceAccountJson: string | undefined) {}

  private async messaging(): Promise<Send> {
    this.sendFn ??= (async () => {
      const { getApps, getApp, initializeApp, applicationDefault, cert } = await import("firebase-admin/app");
      const { getMessaging } = await import("firebase-admin/messaging");
      const name = "push";
      const app = getApps().some((a) => a.name === name)
        ? getApp(name)
        : initializeApp({ projectId: this.projectId, credential: this.serviceAccountJson ? cert(JSON.parse(this.serviceAccountJson)) : applicationDefault() }, name);
      const m = getMessaging(app);
      return (message: object) => m.send(message as Parameters<typeof m.send>[0]);
    })();
    return this.sendFn;
  }

  async send(message: PushMessage): Promise<PushResult> {
    const send = await this.messaging();
    try {
      await send({
        token: message.token,
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: { priority: "high" },
        apns: { payload: { aps: { sound: "default" } } },
        webpush: { fcmOptions: { link: message.data.deepLink } },
      });
      return { ok: true };
    } catch (e) {
      const code = (e as { code?: string }).code;
      return { ok: false, invalidToken: isInvalidTokenError(code), error: `${code ?? "error"}: ${(e as Error).message}` };
    }
  }
}
