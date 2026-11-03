/**
 * DEV ONLY: make DEV_ADMIN_HANDLES admins with every payments permission, without a full reseed
 * (npm run db:dev-admins). Idempotent; refused in production.
 */
import { db, sql } from "../src/client.js";
import { devAdminHandles, grantDevAdmins } from "../src/devAdmins.js";

const handles = devAdminHandles();
try {
  const out = await db.transaction((tx) => grantDevAdmins(tx, handles));
  const missing = handles.filter((h) => !out.some((o) => o.handle === h));
  for (const o of out) console.log(`@${o.handle}: admin, ${o.granted.length ? `granted ${o.granted.join(", ")}` : "already held every payments permission"}`);
  if (missing.length) console.log(`no account for: ${missing.map((h) => `@${h}`).join(", ")} (run db:seed, or sign up with that handle)`);
} catch (e) {
  console.error(`dev-admins refused: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
