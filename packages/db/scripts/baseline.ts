/**
 * One-off, for a database that db:push built before migrations existed (Oct 2026): mark the baseline
 * migration (0000) as applied, so db:migrate starts from there instead of trying to create tables that are
 * already in place. Refuses on an empty database (run db:migrate there) and does nothing if migrations
 * have already been recorded. Run it once per such database, then db:migrate as usual.
 */
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "../src/client.js";

const MIGRATIONS = { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) };
const BASELINE_TABLE = "parties"; // any table the baseline creates

const [baseline] = readMigrationFiles(MIGRATIONS);
const [{ exists }] = await sql`select to_regclass(${`public.${BASELINE_TABLE}`}) is not null as exists`;
if (!exists) {
  console.error("This database is empty: run npm run db:migrate instead.");
  process.exit(1);
}
await sql`create schema if not exists drizzle`;
await sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
const recorded = await sql`select hash from drizzle.__drizzle_migrations`;
if (recorded.length) {
  console.log(`Migrations already recorded (${recorded.length}); nothing to do.`);
} else {
  await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${baseline.hash}, ${baseline.folderMillis})`;
  console.log("Baseline marked as applied. From now on: npm run db:migrate.");
}
await sql.end();
