/**
 * Schema migration entrypoint. Bun only — no Node, no `pg` (see #421).
 *
 * The backend's application layer has run on `Bun.SQL` since #403; this script
 * was the last thing that needed a Node runtime, because `node-pg-migrate`
 * ships a Node CLI. Its programmatic API removed the CLI dependency but not the
 * `pg` driver underneath it, so the runner is now implemented directly against
 * `Bun.SQL` in ./lib.
 *
 * The on-disk and in-database contracts are unchanged: same `pgmigrations`
 * table, same recorded names, same ordering, same advisory lock. A database
 * migrated by the previous tool continues from exactly where it left off.
 *
 * Usage:
 *   bun scripts/migrate.ts up [count]
 *   bun scripts/migrate.ts down [count]
 *   bun scripts/migrate.ts create <name...>
 *
 * Set MIGRATE_VERBOSE=1 to dump each migration's SQL before it executes.
 */
import { createMigration } from "./lib/create-migration";
import { runMigrations } from "./lib/migration-runner";

const USAGE =
  "Usage:\n" +
  "  bun scripts/migrate.ts up [count]\n" +
  "  bun scripts/migrate.ts down [count]\n" +
  "  bun scripts/migrate.ts create <name...>";

/** Resolved from the current working directory, so run this from `backend/`. */
const MIGRATIONS_DIR = "migrations";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Wrapped in a function rather than using top-level await: the backend's
// tsconfig compiles to commonjs, which does not allow it.
async function main(): Promise<void> {
  const [action, ...rest] = Bun.argv.slice(2);

  if (action === "create") {
    try {
      const path = await createMigration(rest, MIGRATIONS_DIR);

      console.log(`Created migration -- ${path}`);
      process.exit(0);
    } catch (error) {
      fail(
        `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
      );
    }
  }

  if (action !== "up" && action !== "down") {
    fail(USAGE);
  }

  // Anything past the count is rejected rather than ignored. This entrypoint
  // deliberately implements a direction and an optional count and no flags, so
  // silently dropping the rest would turn a habitual `up 1 --dry-run` into a
  // real schema change — a flag that used to promise it only printed SQL.
  // Failing here keeps the gap visible; add a flag explicitly if one is needed.
  if (rest.length > 1) {
    fail(
      `Unexpected argument: ${rest[1]}\n` +
        "This entrypoint accepts a direction and an optional count only — it " +
        "does not accept flags such as --dry-run.\n" +
        USAGE,
    );
  }

  const [countArg] = rest;

  // Left undefined when no count is passed, which the runner reads as "every
  // pending migration" for `up` and "one migration" for `down`.
  let count: number | undefined;

  if (countArg !== undefined) {
    // Digits only: `Number.parseInt` alone would read "1abc" as 1, and
    // "--dry-run" is better reported as a bad argument than as a bad number.
    if (!/^\d+$/.test(countArg)) {
      fail(`Invalid migration count: ${countArg}\n${USAGE}`);
    }

    count = Number.parseInt(countArg, 10);
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    fail("The DATABASE_URL environment variable is not set.");
  }

  try {
    await runMigrations({
      databaseUrl,
      direction: action,
      dir: MIGRATIONS_DIR,
      count,
      verbose: process.env.MIGRATE_VERBOSE === "1",
    });

    console.log("Migrations complete!");
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
