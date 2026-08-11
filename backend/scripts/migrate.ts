/**
 * Migration entrypoint driven by node-pg-migrate's programmatic API.
 *
 * The production image is bun-only (no node, and pnpm's node_modules/.bin is
 * not on bun's PATH), so the `node-pg-migrate` CLI shim cannot run there.
 * Invoking bin/node-pg-migrate.js with bun does not work either: the CLI does
 * `await import("dotenv")` behind a try/catch that only swallows node's
 * ERR_MODULE_NOT_FOUND, while bun resolves static import specifiers ahead of
 * execution and fails the whole module when the optional package is absent —
 * which it is, because dotenv/dotenv-expand/config are not dependencies here.
 *
 * Calling `runner()` directly sidesteps the CLI's optional imports entirely
 * and keeps one code path for dev, CI and the production container.
 *
 * Usage: bun scripts/migrate.ts <up|down> [count]
 */
import { runner } from "node-pg-migrate";

const USAGE = "Usage: bun scripts/migrate.ts <up|down> [count]";

const args = Bun.argv.slice(2);
const [direction, countArg] = args;

if (direction !== "up" && direction !== "down") {
  console.error(USAGE);
  process.exit(1);
}

// Anything past the count is rejected rather than ignored. This entrypoint
// deliberately implements two of the CLI's arguments and none of its flags, so
// silently dropping the rest would turn a habitual `up 1 --dry-run` into a real
// schema change — the CLI promises that flag only prints SQL. Failing here
// keeps the gap visible; forward a flag explicitly if one is ever needed.
if (args.length > 2) {
  console.error(
    `Unexpected argument: ${args[2]}\n` +
      "This entrypoint accepts a direction and an optional count only — it does " +
      "not forward node-pg-migrate CLI flags such as --dry-run.\n" +
      USAGE,
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("The DATABASE_URL environment variable is not set.");
  process.exit(1);
}

// Left undefined when no count is passed, which node-pg-migrate reads as
// "every pending migration" — the same default as the CLI.
let count: number | undefined;

if (countArg !== undefined) {
  // Digits only: `Number.parseInt` alone would read "1abc" as 1 and "--dry-run"
  // is better reported as a bad argument than as a bad number.
  if (!/^\d+$/.test(countArg)) {
    console.error(`Invalid migration count: ${countArg}\n${USAGE}`);
    process.exit(1);
  }

  count = Number.parseInt(countArg, 10);
}

// Values below mirror the CLI defaults so behaviour does not shift with this
// entrypoint: migrations/ directory, pgmigrations table, public schema,
// order checking on, and all pending migrations in a single transaction.
try {
  await runner({
    databaseUrl: { connectionString: databaseUrl },
    dir: "migrations",
    direction,
    count,
    migrationsTable: "pgmigrations",
    schema: ["public"],
    checkOrder: true,
    singleTransaction: true,
    verbose: true,
  });

  console.log("Migrations complete!");
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
