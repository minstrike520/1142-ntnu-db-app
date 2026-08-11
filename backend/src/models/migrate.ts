/**
 * Schema migration runner built on Bun.SQL.
 *
 * Replaces the `node-pg-migrate` CLI, which was the last piece of the backend
 * that required a Node runtime and the only reason `pg` was still a dependency.
 * All migrations under `migrations/` are plain SQL, so none of node-pg-migrate's
 * JavaScript `pgm` builder API needs reimplementing — this runner only has to
 * order the files, split each one into its up/down halves, and keep the version
 * table in sync.
 *
 * Bookkeeping is deliberately byte-compatible with node-pg-migrate v9: same
 * `pgmigrations` table shape, same recorded names, same ordering rules, same
 * advisory lock id and the same all-or-nothing transaction. An existing
 * database migrated by the old CLI must see this runner as a no-op, and vice
 * versa — anything else would re-run or skip migrations on deployed stacks.
 *
 * Usage:
 *   bun src/models/migrate.ts up
 *   bun src/models/migrate.ts down [count]
 *   bun src/models/migrate.ts create <name>
 */

import { SQL } from "bun";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// `__dirname`, not `import.meta`: tsconfig.json compiles with "module":
// "commonjs", which rejects import.meta at typecheck time. Bun provides both.
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");
const MIGRATIONS_TABLE = '"public"."pgmigrations"';

// node-pg-migrate's own default lock id. Keeping it means a deployment that
// still runs the old CLI somewhere cannot migrate concurrently with this one.
const ADVISORY_LOCK_ID = 7241865325823964;

// The node-pg-migrate SQL template, plus the trailing newline that 15 of the 16
// existing migrations already carry — the upstream template omits it, which
// leaves a "\ No newline at end of file" marker on every future diff.
const MIGRATION_TEMPLATE = "-- Up Migration\n\n-- Down Migration\n";

export interface MigrationFile {
  /** Basename without extension — this is what lands in `pgmigrations.name`. */
  name: string;
  fileName: string;
  filePath: string;
}

/**
 * Numeric value of everything before the first non-digit, mirroring
 * node-pg-migrate. A 17-digit prefix is a UTC timestamp rather than a plain
 * number; `create` below never emits one, but a hand-written file may, and
 * ordering has to agree with the old CLI either way.
 */
export function getNumericPrefix(fileName: string): number {
  const prefix = /^(\d+)/.exec(fileName)?.[0] ?? "";
  const value = Number(prefix);

  if (!/^\d+$/.test(prefix) || Number.isNaN(value)) {
    throw new Error(`Cannot determine numeric prefix for "${fileName}"`);
  }

  if (prefix.length === 17) {
    const [year, month, date, hours, minutes, seconds, ms] = [
      prefix.slice(0, 4),
      prefix.slice(4, 6),
      prefix.slice(6, 8),
      prefix.slice(8, 10),
      prefix.slice(10, 12),
      prefix.slice(12, 14),
      prefix.slice(14, 17),
    ];
    return new Date(`${year}-${month}-${date}T${hours}:${minutes}:${seconds}.${ms}Z`).valueOf();
  }

  return value;
}

/**
 * Order migrations by numeric prefix, falling back to a locale comparison when
 * two files share one. `migrations/` really does contain such a pair
 * (`2026053000000_create-friendships-and-blocks` and
 * `2026053000000_emergency_contacts`), so the tie-break is load-bearing: the
 * options below are exactly what node-pg-migrate passes to `localeCompare`.
 */
export function compareMigrationFileNames(a: string, b: string): number {
  return (
    getNumericPrefix(a) - getNumericPrefix(b) ||
    a.localeCompare(b, undefined, {
      usage: "sort",
      numeric: true,
      sensitivity: "variant",
      ignorePunctuation: true,
    })
  );
}

function migrationCommentIndex(content: string, direction: "up" | "down"): number {
  return content.search(new RegExp(`^\\s*--[\\s-]*${direction}\\s+migration`, "im"));
}

/**
 * Split a migration file on its `-- Up migration` / `-- Down migration`
 * markers. The marker comment stays attached to the SQL it introduces, matching
 * node-pg-migrate; a file with no down section is up-only and cannot be rolled
 * back.
 */
export function splitMigrationSql(content: string): { up: string; down: string | null } {
  const upStart = migrationCommentIndex(content, "up");
  const downStart = migrationCommentIndex(content, "down");

  return {
    up:
      upStart >= 0
        ? content.slice(upStart, downStart < upStart ? undefined : downStart)
        : content,
    down: downStart >= 0 ? content.slice(downStart, upStart < downStart ? undefined : upStart) : null,
  };
}

/**
 * Reject a migrations directory that has grown a file ordered *before* one
 * already applied — usually a branch merged out of order. Applying it would
 * leave the database in a state no single sequence of migrations produces.
 */
export function assertMigrationOrder(appliedNames: string[], fileNames: string[]): void {
  const shared = Math.min(appliedNames.length, fileNames.length);

  for (let i = 0; i < shared; i += 1) {
    if (appliedNames[i] !== fileNames[i]) {
      throw new Error(
        `Not run migration ${fileNames[i]} is preceding already run migration ${appliedNames[i]}`,
      );
    }
  }
}

export async function loadMigrationFiles(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
    .map((entry) => entry.name);

  // node-pg-migrate also accepted JS/TS migrations. This runner only executes
  // SQL, so refuse anything else loudly instead of feeding it to the database.
  const unsupported = fileNames.filter((fileName) => !fileName.endsWith(".sql"));
  if (unsupported.length > 0) {
    throw new Error(
      `Only .sql migrations are supported, found: ${unsupported.join(", ")}`,
    );
  }

  return fileNames.sort(compareMigrationFileNames).map((fileName) => ({
    fileName,
    name: fileName.slice(0, -".sql".length),
    filePath: path.join(dir, fileName),
  }));
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env or run via: docker compose exec backend bun run migrate:up",
    );
  }

  return databaseUrl;
}

/**
 * Run `handler` against a single pinned connection holding the migration
 * advisory lock. The lock is session-scoped, so it and the migrations must
 * share one connection — a pooled client could hand the work to a different
 * session than the one that took the lock.
 */
async function withLockedConnection<T>(
  handler: (connection: SQL) => Promise<T>,
): Promise<T> {
  const sql = new SQL(requireDatabaseUrl());
  const connection = await sql.reserve();

  try {
    const [{ lockObtained }] = await connection.unsafe(
      `SELECT pg_try_advisory_lock(${ADVISORY_LOCK_ID}) AS "lockObtained"`,
    );

    if (!lockObtained) {
      throw new Error("Another migration is already running.");
    }

    try {
      return await handler(connection as unknown as SQL);
    } finally {
      await connection
        .unsafe(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_ID})`)
        .catch((error: Error) => console.warn(`Failed to release migration lock: ${error.message}`));
    }
  } finally {
    connection.release();
    await sql.close();
  }
}

async function ensureMigrationsTable(connection: SQL): Promise<void> {
  await connection.unsafe(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id SERIAL PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL)`,
  );
}

async function getAppliedNames(connection: SQL): Promise<string[]> {
  const rows: Array<{ name: string }> = await connection.unsafe(
    `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY run_on, id`,
  );

  return rows.map((row) => row.name);
}

async function readMigrationSql(
  migration: MigrationFile,
  direction: "up" | "down",
): Promise<string> {
  const { up, down } = splitMigrationSql(await readFile(migration.filePath, "utf8"));

  if (direction === "up") {
    return up;
  }

  if (down === null) {
    throw new Error(`Migration ${migration.name} has no down migration and cannot be rolled back.`);
  }

  return down;
}

/**
 * Apply `migrations` inside one transaction. node-pg-migrate defaults to
 * `--single-transaction`, so a failure half way through a batch rolls the whole
 * batch back rather than leaving the schema partly migrated.
 */
async function applyMigrations(
  connection: SQL,
  migrations: MigrationFile[],
  direction: "up" | "down",
): Promise<void> {
  await connection.unsafe("BEGIN");

  try {
    for (const migration of migrations) {
      console.log(`### MIGRATION ${migration.name} (${direction.toUpperCase()}) ###`);
      await connection.unsafe(await readMigrationSql(migration, direction));

      if (direction === "up") {
        await connection`INSERT INTO public.pgmigrations (name, run_on) VALUES (${migration.name}, NOW())`;
      } else {
        await connection`DELETE FROM public.pgmigrations WHERE name = ${migration.name}`;
      }
    }

    await connection.unsafe("COMMIT");
  } catch (error) {
    console.warn("> Rolling back attempted migration ...");
    await connection.unsafe("ROLLBACK");
    throw error;
  }
}

async function migrateUp(): Promise<void> {
  await withLockedConnection(async (connection) => {
    await ensureMigrationsTable(connection);

    const migrations = await loadMigrationFiles();
    const appliedNames = await getAppliedNames(connection);
    assertMigrationOrder(
      appliedNames,
      migrations.map((migration) => migration.name),
    );

    const pending = migrations.filter((migration) => !appliedNames.includes(migration.name));

    if (pending.length === 0) {
      console.log("No migrations to run!");
      return;
    }

    console.log("> Migrating files:");
    for (const migration of pending) {
      console.log(`> - ${migration.name}`);
    }

    await applyMigrations(connection, pending, "up");
    console.log("Migrations complete!");
  });
}

async function migrateDown(count: number): Promise<void> {
  await withLockedConnection(async (connection) => {
    await ensureMigrationsTable(connection);

    const migrations = await loadMigrationFiles();
    const appliedNames = await getAppliedNames(connection);

    // Newest first: rolling back has to undo migrations in reverse order.
    const toRun = appliedNames.slice(-count).reverse();
    const missing = toRun.filter((name) => !migrations.some((migration) => migration.name === name));

    if (missing.length > 0) {
      throw new Error(`Definitions of migrations ${missing.join(", ")} have been deleted.`);
    }

    if (toRun.length === 0) {
      console.log("No migrations to run!");
      return;
    }

    console.log("> Migrating files:");
    for (const name of toRun) {
      console.log(`> - ${name}`);
    }

    await applyMigrations(
      connection,
      toRun.map((name) => migrations.find((migration) => migration.name === name)!),
      "down",
    );
    console.log("Migrations complete!");
  });
}

async function createMigration(name: string): Promise<void> {
  await mkdir(MIGRATIONS_DIR, { recursive: true });

  const filePath = path.join(MIGRATIONS_DIR, `${Date.now()}_${name}.sql`);
  await writeFile(filePath, MIGRATION_TEMPLATE, { flag: "wx" });

  console.log(`Created migration -- ${filePath}`);
}

function usage(): string {
  return [
    "Usage:",
    "  bun src/models/migrate.ts up",
    "  bun src/models/migrate.ts down [count]",
    "  bun src/models/migrate.ts create <name>",
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  const [action, argument] = argv;

  switch (action) {
    case "up":
      return migrateUp();

    case "down": {
      const count = argument === undefined ? 1 : Number(argument);

      if (!Number.isInteger(count) || count < 1) {
        throw new Error(`Invalid migration count "${argument}": expected a positive integer.`);
      }

      return migrateDown(count);
    }

    case "create": {
      if (!argument) {
        throw new Error(`Missing migration name.\n${usage()}`);
      }

      return createMigration(argument);
    }

    default:
      throw new Error(`Unknown action "${action ?? ""}".\n${usage()}`);
  }
}

// Guarded so the exported helpers above can be imported by tests without the
// import itself trying to reach a database. Compared against argv rather than
// `import.meta.main` for the same commonjs-typecheck reason as MIGRATIONS_DIR.
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
