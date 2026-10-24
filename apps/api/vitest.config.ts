import { defineConfig } from "vitest/config";

// Unit tests only: nothing here needs Postgres or Valkey. The database-backed tests are test-int (npm run test:int).
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
