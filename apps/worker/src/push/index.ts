/**
 * Push, behind the vendor-neutral PushSender (packages/db), selected by PUSH_PROVIDER: "log" (the default:
 * dev and tests, records what would be sent) or "fcm". Adding one is a file implementing PushSender and an
 * entry here. FCM sends through PUSH_FIREBASE_PROJECT_ID (default FIREBASE_PROJECT_ID) with
 * FIREBASE_SERVICE_ACCOUNT_JSON. Outside production, fcm needs FIREBASE_PRODUCTION_PROJECT_ID set and refuses
 * to send through that project: dev and staging never push to real people from the live Firebase project.
 */
import type { PushSender } from "@contestly/db";
import { LogPushSender } from "./log.js";
import { FcmPushSender } from "./fcm.js";

export function selectPushSender(env: NodeJS.ProcessEnv = process.env): PushSender {
  const name = env.PUSH_PROVIDER ?? "log";
  if (name === "log") {
    if (env.NODE_ENV === "production") console.warn("[push] PUSH_PROVIDER=log in production: pushes are only logged");
    return new LogPushSender();
  }
  if (name === "fcm") {
    const projectId = env.PUSH_FIREBASE_PROJECT_ID || env.FIREBASE_PROJECT_ID;
    if (!projectId) throw new Error("PUSH_PROVIDER=fcm needs PUSH_FIREBASE_PROJECT_ID (or FIREBASE_PROJECT_ID)");
    if (env.NODE_ENV !== "production") {
      const live = env.FIREBASE_PRODUCTION_PROJECT_ID;
      if (!live) throw new Error("PUSH_PROVIDER=fcm outside production needs FIREBASE_PRODUCTION_PROJECT_ID, so it can refuse to send through it");
      if (projectId === live) throw new Error(`refusing to push through the production Firebase project (${live}) outside production`);
    }
    return new FcmPushSender(projectId, env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  throw new Error(`PUSH_PROVIDER=${name} is not a registered provider (have: log, fcm)`);
}
