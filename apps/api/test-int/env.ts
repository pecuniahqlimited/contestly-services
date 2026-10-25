// Every test process: point the packages at the test database and Valkey db before anything imports them.
import { loadTestEnv } from "./testEnv.js";

const env = loadTestEnv();
process.env.DATABASE_URL = env.testDatabaseUrl;
process.env.REDIS_URL = env.testRedisUrl;
process.env.LOG_LEVEL = "silent";
