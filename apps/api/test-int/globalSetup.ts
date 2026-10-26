/** Once per run: a fresh test database, migrated from packages/db/drizzle, and an empty test Valkey db. */
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Redis } from "ioredis";
import { loadTestEnv } from "./testEnv.js";

export default async function setup() {
  const env = loadTestEnv();
  const server = postgres(env.devDatabaseUrl, { max: 1, onnotice: () => {} });
  await server.unsafe(`drop database if exists "${env.testDatabaseName}" with (force)`);
  await server.unsafe(`create database "${env.testDatabaseName}"`);
  await server.end();

  const test = postgres(env.testDatabaseUrl, { max: 1, onnotice: () => {} });
  await migrate(drizzle(test), { migrationsFolder: fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url)) });
  await test.end();

  const redis = new Redis(env.testRedisUrl);
  await redis.flushdb(); // only the test db index
  await redis.quit();
}
