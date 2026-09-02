/**
 * Schema migration runner built on Bun.SQL.
 * Compatible with node-pg-migrate table format (`pgmigrations`).
 *
 * Usage:
 *   bun src/models/migrate.ts up [--database-url=<url>] [--yes]
 *   bun src/models/migrate.ts down [count] [--database-url=<url>] [--yes]
 *   bun src/models/migrate.ts create <name>
 */

import { SQL } from "bun";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describeDatabaseTarget } from "../utils/describeDatabaseTarget";

// Migration files location relative to compiled script.
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");
const MIGRATIONS_TABLE = '"public"."pgmigrations"';

// Advisory lock ID to ensure only one migration runs at a time.
const ADVISORY_LOCK_ID = 7241865325823964;

// Default SQL migration template with Up and Down sections.
const MIGRATION_TEMPLATE = "-- Up Migration\n\n-- Down Migration\n";

export interface MigrationFile {
  /** Migration name without .sql extension. */
  name: string;
  fileName: string;
  filePath: string;
}

/** Extracts the numeric or timestamp prefix from a migration filename. */
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

/** Sorts migration files by numeric prefix, breaking ties alphabetically. */
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

/** Splits migration SQL content into Up and Down sections. */
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

/** Verifies that pending migrations have not been inserted before already applied migrations. */
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

export interface MigrateArgs {
  action?: string;
  argument?: string;
  /** `--database-url`, when given. Takes precedence over `DATABASE_URL`. */
  databaseUrl?: string;
  assumeYes: boolean;
}

/**
 * Split argv into the action, its positional argument, and the two options.
 * Options may appear anywhere, so `down 3 --yes` and `down --yes 3` agree.
 */
export function parseMigrateArgs(argv: string[]): MigrateArgs {
  const positionals: string[] = [];
  let databaseUrl: string | undefined;
  let assumeYes = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "--yes" || token === "-y") {
      assumeYes = true;
      continue;
    }

    if (token === "--database-url" || token.startsWith("--database-url=")) {
      // Both spellings: `--database-url=<url>` reads well inside a package.json
      // script, the separated form inside an interactive shell.
      const value = token.startsWith("--database-url=")
        ? token.slice("--database-url=".length)
        : argv[i += 1];

      if (!value) {
        throw new Error(`--database-url requires a connection string.\n${usage()}`);
      }

      databaseUrl = value;
      continue;
    }

    if (token.startsWith("-")) {
      throw new Error(`Unknown option "${token}".\n${usage()}`);
    }

    positionals.push(token);
  }

  return { action: positionals[0], argument: positionals[1], databaseUrl, assumeYes };
}

/** Database hosts permitted without interactive confirmation. */
export const LOCAL_DATABASE_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "::1",
  "db",
  "db-test",
];

export function isLocalDatabaseTarget(connectionString: string): boolean {
  try {
    const { hostname } = new URL(connectionString);
    if (!hostname) return false;
    return LOCAL_DATABASE_HOSTS.includes(hostname.replace(/^\[|\]$/g, "").toLowerCase());
  } catch {
    return false;
  }
}

/** Resolves migration target database URL from CLI flag or environment. */
export function resolveDatabaseUrl(
  flagValue: string | undefined,
  source: NodeJS.ProcessEnv = process.env,
): string {
  const databaseUrl = flagValue ?? source.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "No migration target. Pass --database-url=<connection string>, or set DATABASE_URL — e.g. docker compose exec backend bun run migrate:up",
    );
  }

  return databaseUrl;
}

async function readConfirmation(): Promise<string> {
  process.stdin.setEncoding("utf8");

  for await (const chunk of process.stdin) {
    return String(chunk).split("\n")[0]!.trim();
  }

  return "";
}

/** Prompts for confirmation when targeting a non-local database without --yes. */
async function confirmTarget(databaseUrl: string, assumeYes: boolean): Promise<void> {
  if (assumeYes || isLocalDatabaseTarget(databaseUrl)) {
    return;
  }

  const target = describeDatabaseTarget(databaseUrl);
  const expected = target.slice(target.lastIndexOf("/") + 1);

  if (!process.stdin.isTTY) {
    throw new Error(
      `Refusing to migrate ${target}: not a local target, and there is no terminal to confirm on. Pass --yes to proceed.`,
    );
  }

  process.stdout.write(
    `${target} is not a local database.\nType "${expected}" to migrate it, anything else to abort: `,
  );

  if ((await readConfirmation()) !== expected) {
    throw new Error(`Aborted: ${target} was not confirmed.`);
  }
}

/** Runs migration handler inside a reserved connection holding an advisory lock. */
async function withLockedConnection<T>(
  databaseUrl: string,
  handler: (connection: SQL) => Promise<T>,
): Promise<T> {
  const sql = new SQL(databaseUrl);
  const connection = await sql.reserve();

  try {
    const [{ lockObtained }] = await connection.unsafe(
      `SELECT pg_try_advisory_lock(${ADVISORY_LOCK_ID}) AS "lockObtained"`,
    );

    if (!lockObtained) {
      throw new Error("Another migration is already running.");
    }

    try {
      return await handler(connection);
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

/** Applies a batch of migrations within a single transaction. */
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

      await connection.unsafe(
        direction === "up"
          ? `INSERT INTO ${MIGRATIONS_TABLE} (name, run_on) VALUES ($1, NOW())`
          : `DELETE FROM ${MIGRATIONS_TABLE} WHERE name = $1`,
        [migration.name],
      );
    }

    await connection.unsafe("COMMIT");
  } catch (error) {
    console.warn("> Rolling back attempted migration ...");
    await connection
      .unsafe("ROLLBACK")
      .catch((rollbackError: Error) => console.warn(`> Rollback failed: ${rollbackError.message}`));
    throw error;
  }
}

async function migrateUp(databaseUrl: string): Promise<void> {
  await withLockedConnection(databaseUrl, async (connection) => {
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

async function migrateDown(count: number, databaseUrl: string): Promise<void> {
  await withLockedConnection(databaseUrl, async (connection) => {
    await ensureMigrationsTable(connection);

    const migrations = await loadMigrationFiles();
    const appliedNames = await getAppliedNames(connection);
    assertMigrationOrder(
      appliedNames,
      migrations.map((migration) => migration.name),
    );

    // Rollback migrations in reverse order (newest first).
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

  // Generate monotonically increasing prefix to guarantee ordering.
  const existing = await loadMigrationFiles();
  const highestPrefix = existing.reduce(
    (highest, migration) => Math.max(highest, getNumericPrefix(migration.fileName)),
    0,
  );
  const prefix = Math.max(Date.now(), highestPrefix + 1);

  const filePath = path.join(MIGRATIONS_DIR, `${prefix}_${name}.sql`);
  await writeFile(filePath, MIGRATION_TEMPLATE, { flag: "wx" });

  console.log(`Created migration -- ${filePath}`);
}

function usage(): string {
  return [
    "Usage:",
    "  bun src/models/migrate.ts up [--database-url=<url>] [--yes]",
    "  bun src/models/migrate.ts down [count] [--database-url=<url>] [--yes]",
    "  bun src/models/migrate.ts create <name>",
    "",
    "Options:",
    "  --database-url=<url>  Database to migrate. Falls back to DATABASE_URL.",
    "  --yes, -y             Skip the confirmation a non-local target requires.",
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  const { action, argument, databaseUrl: databaseUrlFlag, assumeYes } = parseMigrateArgs(argv);

  // `create` only writes a file, so it must not demand a database at all.
  if (action === "create") {
    if (!argument) {
      throw new Error(`Missing migration name.\n${usage()}`);
    }

    return createMigration(argument);
  }

  if (action !== "up" && action !== "down") {
    throw new Error(`Unknown action "${action ?? ""}".\n${usage()}`);
  }

  const count = action === "down" && argument !== undefined ? Number(argument) : 1;

  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Invalid migration count "${argument}": expected a positive integer.`);
  }

  const databaseUrl = resolveDatabaseUrl(databaseUrlFlag);

  // Named before anything is opened, locked or altered, so the operator sees
  // the target while it can still be refused. Never the URL itself: it carries
  // credentials.
  console.log(`MIGRATE: target=${describeDatabaseTarget(databaseUrl)}`);
  await confirmTarget(databaseUrl, assumeYes);

  return action === "up" ? migrateUp(databaseUrl) : migrateDown(count, databaseUrl);
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
