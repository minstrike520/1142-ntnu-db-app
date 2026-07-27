import { SQL } from "bun";
import { describeDatabaseTarget } from "../utils/describeDatabaseTarget";

// DATABASE_URL_TEST may only win inside the test runner. The regular compose
// stack also defines it (defaulting to the `db-test` host that only
// docker-compose.test.yml starts), so preferring it unconditionally pointed a
// plain `docker compose up` at a database that does not exist.
const isTestEnv = process.env.NODE_ENV === "test";
const connectionString =
  (isTestEnv ? process.env.DATABASE_URL_TEST : undefined) || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "No database connection string configured: set DATABASE_URL (or DATABASE_URL_TEST when NODE_ENV=test).",
  );
}

// Log the target, never the connection string — it embeds the DB credentials.
console.log(
  `DB INIT: env=${process.env.NODE_ENV ?? "unknown"} target=${describeDatabaseTarget(connectionString)}`,
);

const sql = new SQL(connectionString);

export default sql;
