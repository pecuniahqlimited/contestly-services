import { defineConfig } from "vitest/config";

// Integration tests on the local Postgres and Valkey servers (npm run infra:up), in their own database and Valkey db: never the dev data.
export default defineConfig({
  test: { include: ["test-int/**/*.test.ts"], globalSetup: ["test-int/globalSetup.ts"], setupFiles: ["test-int/env.ts"], fileParallelism: false, testTimeout: 20_000, hookTimeout: 30_000 },
});
