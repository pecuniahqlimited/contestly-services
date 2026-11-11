// Every test process: point the packages at the test database and Valkey db before anything imports them.
import { loadTestEnv } from "./testEnv.js";

const env = loadTestEnv();
process.env.DATABASE_URL = env.testDatabaseUrl;
process.env.REDIS_URL = env.testRedisUrl;
process.env.LOG_LEVEL = "silent";
// Payments: the mock provider and dev tools, with a webhook secret of the tests' own (ADR 0013).
process.env.PAYMENTS_DEV_TOOLS = "true";
process.env.MOCK_PAYMENTS_WEBHOOK_SECRET ||= "test-mock-webhook-secret";
// AI providers (ADR 0016): the ceiling and the paid cap only. Which profile runs is the routing, which tests set
// through the admin API (it starts on mock: routing version 1 with AI_PROFILE unset); tests never call a provider.
delete process.env.AI_PROFILE;
process.env.AI_ALLOWED_PROFILES = "mock,free";
process.env.AI_PAID_CAP_USD = "0";
