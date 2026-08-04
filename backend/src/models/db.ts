import { SQL } from "bun";
import { env } from "../config/env";
import { describeDatabaseTarget } from "../utils/describeDatabaseTarget";

// Which of DATABASE_URL / DATABASE_URL_TEST applies is resolved in config/env.ts.
const { databaseUrl: connectionString, isTest: isTestEnv, nodeEnv } = env();

// Fail fast on a misconfigured deployment rather than at the first query — but
// not under the test runner: unit tests mock this module or never issue a query,
// and their CI job deliberately runs with no database configured. Suites that do
// need a database set DATABASE_URL_TEST, and tests/helpers/testPool.ts raises its
// own error when they don't.
if (!connectionString && !isTestEnv) {
  throw new Error(
    "No database connection string configured: set DATABASE_URL (or DATABASE_URL_TEST when NODE_ENV=test).",
  );
}

// Log the target, never the connection string — it embeds the DB credentials.
console.log(
  `DB INIT: env=${nodeEnv ?? "unknown"} target=${describeDatabaseTarget(connectionString)}`,
);

// Bun's SQL client connects lazily, so an unconfigured test run only fails if
// something actually queries — and then the host name says why.
const sql = new SQL(connectionString ?? "postgresql://database-not-configured-in-test-env/");

export default sql;
