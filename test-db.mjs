 import postgres from "postgres";
import dotenv from "dotenv";


dotenv.config({ path: ".env" });

if (!process.env.DATABASE_URL) {
console.log("DATABASE_URL missing from root .env");
process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { connect_timeout: 5 });

try {
console.log(
await sql.unsafe(
"SELECT current_user, current_database(), inet_server_port()"
)
);
} catch (error) {
console.log("Connection failed:", error.code, error.message);
} finally {
await sql.end();
}
