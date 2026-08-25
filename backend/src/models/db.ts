import { SQL } from "bun";
import { describeDatabaseTarget } from "../utils/describeDatabaseTarget";
import { instrumentSql } from "./instrumentSql";

// DATABASE_URL_TEST may only win inside the test runner. The regular compose
// stack also defines it (defaulting to the `db-test` host that only
// docker-compose.test.yml starts), so preferring it unconditionally pointed a
// plain `docker compose up` at a database that does not exist.
const isTestEnv = process.env.NODE_ENV === "test";
const connectionString =
  (isTestEnv ? process.env.DATABASE_URL_TEST : undefined) || process.env.DATABASE_URL;

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
  `DB INIT: env=${process.env.NODE_ENV ?? "unknown"} target=${describeDatabaseTarget(connectionString)}`,
);

// Bun's SQL client connects lazily, so an unconfigured test run only fails if
// something actually queries — and then the host name says why.
const sql = new SQL(connectionString ?? "postgresql://database-not-configured-in-test-env/");

// Wrapped once, here, so every repository gets query timing by defaulting to
// this export — including repositories written after today. See instrumentSql.ts
// for why the client is the interception point rather than the repositories.
export default instrumentSql(sql);
