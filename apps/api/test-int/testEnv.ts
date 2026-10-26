/**
 * Where integration tests run: never the dev database. The same Postgres server with its own database
 * (contestly_test, or TEST_DATABASE_NAME), and its own Valkey logical db (TEST_REDIS_DB, default 15) so no
 * dev worker ever picks up a test's jobs. The repo's .env supplies the servers.
 */
import { fileURLToPath } from "node:url";

export function loadTestEnv() {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
  const devDb = new URL(process.env.DATABASE_URL ?? "postgres://contestly:contestly@localhost:5432/contestly");
  const testDb = new URL(devDb);
  testDb.pathname = `/${process.env.TEST_DATABASE_NAME ?? "contestly_test"}`;
  if (testDb.pathname === devDb.pathname) throw new Error("TEST_DATABASE_NAME must differ from the dev database");
  const redis = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  redis.pathname = `/${process.env.TEST_REDIS_DB ?? "15"}`;
  return { devDatabaseUrl: devDb.toString(), testDatabaseUrl: testDb.toString(), testDatabaseName: testDb.pathname.slice(1), testRedisUrl: redis.toString() };
}
