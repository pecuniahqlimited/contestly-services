import { assertAuthConfig } from "@contestly/auth";
import { grantConfiguredAdmins } from "@contestly/db";
import { buildApp } from "./app.js";

// Refuses AUTH_MODE=dev in production, and production without its sign-in secrets.
assertAuthConfig();

const app = await buildApp();
const admins = await grantConfiguredAdmins();
if (admins) app.log.info(`granted the admin role to ${admins} account(s) from ADMIN_EMAILS`);

const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
