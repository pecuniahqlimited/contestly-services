// Every test process: point the packages at the test database and Valkey db before anything imports them.
import { loadTestEnv } from "./testEnv.js";

const env = loadTestEnv();
process.env.DATABASE_URL = env.testDatabaseUrl;
process.env.REDIS_URL = env.testRedisUrl;
process.env.LOG_LEVEL = "silent";
// Payments: the mock provider and dev tools, with a webhook secret of the tests' own (ADR 0013).
process.env.PAYMENTS_DEV_TOOLS = "true";
process.env.MOCK_PAYMENTS_WEBHOOK_SECRET ||= "test-mock-webhook-secret";
