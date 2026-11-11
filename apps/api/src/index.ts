import { assertAuthConfig } from "@contestly/auth";
import { grantConfiguredAdmins } from "@contestly/db";
import { QUEUE_PREFIX, startHeartbeat } from "@contestly/queue";
import { buildApp } from "./app.js";
import { valkey } from "./redis.js";

// Refuses AUTH_MODE=dev in production, and production without its sign-in secrets.
assertAuthConfig();

const app = await buildApp();
const admins = await grantConfiguredAdmins();
if (admins) app.log.info(`granted the admin role to ${admins} account(s) from ADMIN_EMAILS`);

const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
// GET /health/deep reads every process's heartbeat, this one's included.
startHeartbeat(valkey(), QUEUE_PREFIX, "api");
