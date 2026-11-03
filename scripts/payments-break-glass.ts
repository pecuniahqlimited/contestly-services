/**
 * BREAK-GLASS: grant payments.config to an admin straight from the server, when the payments console is
 * stuck (fewer than two unbanned config holders, so nobody can confirm a grant). Needs the server and the
 * database; there is no API route for it, by design (ADR 0013, docs/engineering/deploy-notes.md).
 *
 *   npm run payments:break-glass -- --grant-config <handle> --reason "why, and a ticket"
 *
 * Logged as the system in admin_actions (with the reason and the OS user) and raised as a critical alert,
 * in one transaction. Granting to someone who already holds it changes nothing.
 */
import { userInfo } from "node:os";
import { sql } from "@contestly/db";
import { breakGlassGrantConfig, CONFIG_HOLDER_FLOOR } from "@contestly/payments";

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const handle = arg("--grant-config");
const reason = arg("--reason");
if (!handle || !reason || handle.startsWith("--")) {
  console.error('usage: npm run payments:break-glass -- --grant-config <handle> --reason "why"');
  process.exit(1);
}

try {
  const out = await breakGlassGrantConfig(handle, reason, userInfo().username);
  console.log(out.granted
    ? `payments.config granted to @${out.user.handle}: ${out.holders} holder(s) now (the console needs ${CONFIG_HOLDER_FLOOR}). Logged as payments.break_glass; a critical alert was raised.`
    : `@${out.user.handle} already holds payments.config; nothing changed (${out.holders} holder(s)).`);
} catch (e) {
  const err = e as Error & { details?: unknown };
  console.error(`break-glass refused: ${err.message}${err.details ? ` ${JSON.stringify(err.details)}` : ""}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
