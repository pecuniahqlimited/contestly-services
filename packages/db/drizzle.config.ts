import { config } from "dotenv";
// drizzle-kit runs from packages/db; the one .env lives at the repo root.
config({ path: "../../.env" });
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://contestly:contestly@localhost:5432/contestly" },
});
