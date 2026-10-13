import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

const url = process.env.DATABASE_URL ?? "postgres://contestly:contestly@localhost:5432/contestly";
// Keep the pool small per process; the managed DB's PgBouncer does the heavy lifting in production.
export const sql = postgres(url, { max: Number(process.env.DB_POOL_MAX ?? 10) });
export const db = drizzle(sql, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
