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

const [direction, countArg] = Bun.argv.slice(2);

if (direction !== "up" && direction !== "down") {
  console.error("Usage: bun scripts/migrate.ts <up|down> [count]");
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
  count = Number.parseInt(countArg, 10);

  if (Number.isNaN(count)) {
    console.error(`Invalid migration count: ${countArg}`);
    process.exit(1);
  }
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
