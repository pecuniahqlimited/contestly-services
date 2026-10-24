import { defineConfig } from "vitest/config";

// Integration tests against the local stack's Postgres and Valkey (npm run infra:up + db:migrate first).
export default defineConfig({
  test: { include: ["test-int/**/*.test.ts"], setupFiles: ["test-int/env.ts"], fileParallelism: false, testTimeout: 20_000, hookTimeout: 30_000 },
});
