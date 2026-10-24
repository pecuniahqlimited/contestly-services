// The repo's .env, as the services read it (DATABASE_URL, REDIS_URL, AUTH_MODE…). Quiet logs.
import { fileURLToPath } from "node:url";
process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
process.env.LOG_LEVEL = "silent";
