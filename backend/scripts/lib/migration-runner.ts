/**
 * Database half of the migration runner, built on `Bun.SQL`.
 *
 * This replaces `node-pg-migrate` (see #421). The application layer already
 * spoke to PostgreSQL through `Bun.SQL`; the migration tool was the last thing
 * in the backend that needed a Node runtime and the only reason `pg` and
 * `@types/pg` were still installed.
 *
 * The contract with an already-migrated database is preserved exactly: same
 * `pgmigrations` table and columns, same recorded names, same ordering, same
 * advisory lock id, and the same all-or-nothing transaction around a run. An
 * environment migrated by the old tool continues from where it left off without
 * re-running or skipping anything.
 */
import { SQL } from "bun";
import type { ReservedSQL } from "bun";

import {
  getExecutableSql,
  loadMigrationFiles,
  type MigrationDirection,
  type MigrationFile,
} from "./migration-files";

/** Version table, schema and lock id inherited from `node-pg-migrate`. */
export const MIGRATIONS_TABLE = "pgmigrations";
export const MIGRATIONS_SCHEMA = "public";

/**
 * The well-known advisory lock id `node-pg-migrate` used. Keeping the same
 * value matters during a rolling deployment: a container still running the old
 * tool and one running this runner must contend for the *same* lock rather than
 * migrating concurrently.
 */
export const ADVISORY_LOCK_ID = 7241865325823964;

/** Both identifiers are compile-time constants, never user input. */
const QUALIFIED_MIGRATIONS_TABLE = `"${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`;

export interface MigrationRunOptions {
  databaseUrl: string;
  direction: MigrationDirection;
  /** Migrations directory, resolved from the current working directory. */
  dir: string;
  /** How many migrations to run. Defaults to all pending for `up`, 1 for `down`. */
  count?: number;
  /** Dumps each migration's SQL before executing it. */
  verbose?: boolean;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

/**
 * Creates the version table when absent.
 *
 * Runs before the migration transaction and is committed on its own, so a
 * failing migration still leaves a usable (empty) version table behind — the
 * same split the previous tool had.
 */
async function ensureMigrationsTable(connection: ReservedSQL): Promise<void> {
  const tables = await connection.unsafe(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2`,
    [MIGRATIONS_SCHEMA, MIGRATIONS_TABLE],
  );

  if (tables.length === 0) {
    await connection.unsafe(
      `CREATE TABLE ${QUALIFIED_MIGRATIONS_TABLE} ` +
        "(id SERIAL PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL)",
    );

    return;
  }

  // Repairs the one legacy shape the previous tool also repaired: a version
  // table created before it added a primary key.
  const primaryKeys = await connection.unsafe(
    `SELECT constraint_name
     FROM information_schema.table_constraints
     WHERE table_schema = $1 AND table_name = $2 AND constraint_type = 'PRIMARY KEY'`,
    [MIGRATIONS_SCHEMA, MIGRATIONS_TABLE],
  );

  if (primaryKeys.length === 0) {
    await connection.unsafe(
      `ALTER TABLE ${QUALIFIED_MIGRATIONS_TABLE} ADD PRIMARY KEY (id)`,
    );
  }
}

/** Names of already-applied migrations, oldest first. */
async function getAppliedNames(connection: ReservedSQL): Promise<string[]> {
  const rows = (await connection.unsafe(
    `SELECT name FROM ${QUALIFIED_MIGRATIONS_TABLE} ORDER BY run_on, id`,
  )) as Array<{ name: string }>;

  return rows.map((row) => row.name);
}

/**
 * Rejects a migration directory that has gained a file ordered *before* one
 * already applied — the classic result of two branches merging with
 * interleaved timestamps. Applying it now would produce a database whose schema
 * depends on merge order, so the run stops instead.
 */
function assertConsistentOrder(
  appliedNames: string[],
  migrations: MigrationFile[],
): void {
  const shared = Math.min(appliedNames.length, migrations.length);

  for (let index = 0; index < shared; index += 1) {
    const appliedName = appliedNames[index];
    const migrationName = migrations[index]?.name;

    if (appliedName !== migrationName) {
      throw new Error(
        `Not run migration ${migrationName} is preceding already run migration ${appliedName}`,
      );
    }
  }
}

/** Pending migrations, oldest first, capped by `count`. */
export function selectPending(
  appliedNames: string[],
  migrations: MigrationFile[],
  count: number | undefined,
): MigrationFile[] {
  const applied = new Set(appliedNames);
  const pending = migrations.filter(
    (migration) => !applied.has(migration.name),
  );

  return count === undefined ? pending : pending.slice(0, Math.max(0, count));
}

/** Applied migrations to revert, newest first, defaulting to a single one. */
export function selectApplied(
  appliedNames: string[],
  migrations: MigrationFile[],
  count: number | undefined,
): MigrationFile[] {
  const byName = new Map(
    migrations.map((migration) => [migration.name, migration]),
  );

  const limit = count ?? 1;

  // Guarded rather than fed to `slice`, because `slice(-0)` is `slice(0)` —
  // the whole array. `migrate down 0` therefore used to revert every applied
  // migration, wiping the schema on a command that reads as a no-op. `up 0`
  // was already zero migrations, so zero means zero in both directions now.
  if (limit <= 0) return [];

  const targets = appliedNames.slice(-limit).reverse();
  const missing = targets.filter((name) => !byName.has(name));

  if (missing.length > 0) {
    throw new Error(
      `Definitions of migrations ${missing.join(", ")} have been deleted.`,
    );
  }

  return targets.map((name) => byName.get(name) as MigrationFile);
}

/**
 * Runs one migration and records it, inside the caller's transaction.
 *
 * The section is sent as a single statement so PostgreSQL's simple query
 * protocol executes the file as written — migrations here contain multiple
 * statements, dollar-quoted function bodies and `DO` blocks, none of which
 * survive naive statement splitting.
 */
async function applyMigration(
  connection: ReservedSQL,
  migration: MigrationFile,
  direction: MigrationDirection,
  options: Required<Pick<MigrationRunOptions, "verbose" | "logger">>,
): Promise<void> {
  const { logger, verbose } = options;
  const section =
    direction === "up" ? migration.sections.up : migration.sections.down;

  if (section === undefined) {
    throw new Error(
      `User has disabled ${direction} migration on file: ${migration.name}`,
    );
  }

  logger.info(`### MIGRATION ${migration.name} (${direction.toUpperCase()}) ###`);

  const sql = getExecutableSql(section);

  if (verbose && sql) {
    logger.info(`${sql}\n`);
  }

  if (sql) {
    await connection.unsafe(sql);
  }

  if (direction === "up") {
    await connection.unsafe(
      `INSERT INTO ${QUALIFIED_MIGRATIONS_TABLE} (name, run_on) VALUES ($1, NOW())`,
      [migration.name],
    );
  } else {
    await connection.unsafe(
      `DELETE FROM ${QUALIFIED_MIGRATIONS_TABLE} WHERE name = $1`,
      [migration.name],
    );
  }
}

/**
 * Applies or reverts migrations and returns the names that ran.
 *
 * The whole run is one transaction, so a failure half-way leaves the schema and
 * `pgmigrations` untouched rather than partially advanced.
 */
export async function runMigrations(
  options: MigrationRunOptions,
): Promise<string[]> {
  const { databaseUrl, direction, dir, count } = options;
  const logger = options.logger ?? console;
  const verbose = options.verbose ?? false;

  // A pool of one keeps every statement — including the advisory lock, which is
  // session-scoped — on the connection `reserve()` hands back.
  const sql = new SQL(databaseUrl, { max: 1 });

  try {
    const connection = await sql.reserve();

    try {
      const [lock] = (await connection.unsafe(
        `SELECT pg_try_advisory_lock(${ADVISORY_LOCK_ID}) AS obtained`,
      )) as Array<{ obtained: boolean }>;

      if (!lock?.obtained) {
        throw new Error("Another migration is already running.");
      }

      try {
        await connection.unsafe(`SET search_path TO "${MIGRATIONS_SCHEMA}"`);
        await ensureMigrationsTable(connection);

        const migrations = await loadMigrationFiles(dir);
        const appliedNames = await getAppliedNames(connection);

        assertConsistentOrder(appliedNames, migrations);

        const toRun =
          direction === "up"
            ? selectPending(appliedNames, migrations, count)
            : selectApplied(appliedNames, migrations, count);

        if (toRun.length === 0) {
          logger.info("No migrations to run!");

          return [];
        }

        logger.info("> Migrating files:");

        for (const migration of toRun) {
          logger.info(`> - ${migration.name}`);
        }

        await connection.unsafe("BEGIN");

        let failed: MigrationFile | undefined;

        try {
          for (const migration of toRun) {
            failed = migration;
            await applyMigration(connection, migration, direction, {
              logger,
              verbose,
            });
          }

          failed = undefined;
          await connection.unsafe("COMMIT");
        } catch (error) {
          logger.warn("> Rolling back attempted migration ...");
          await connection.unsafe("ROLLBACK");

          // The driver's error says what PostgreSQL rejected but not which file
          // it came from, and a run of two dozen migrations is one statement
          // stream to it. Naming the file is the difference between a usable
          // failure and a syntax error with no address.
          throw failed === undefined
            ? error
            : new Error(`Migration failed: ${failed.name} (${direction})`, {
                cause: error,
              });
        }

        return toRun.map((migration) => migration.name);
      } finally {
        await connection
          .unsafe(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_ID})`)
          .catch((error: unknown) => {
            logger.warn(`Failed to release migration lock: ${String(error)}`);
          });
      }
    } finally {
      connection.release();
    }
  } finally {
    await sql.close();
  }
}
