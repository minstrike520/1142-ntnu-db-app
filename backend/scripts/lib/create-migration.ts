/**
 * Scaffolds a new migration file.
 *
 * This is deliberately not a like-for-like port of `node-pg-migrate create`.
 * That command was broken for this repository in two ways, both of which only
 * showed up after the file was written:
 *
 *  1. It defaulted `--migration-file-language` to `js` and wrote a `.js`
 *     migration. Every migration here is plain SQL and the runner is now
 *     SQL-only, so the generated file could never have been applied.
 *  2. Its default `timestamp` prefix is `Date.now()` — about `1786…` today —
 *     while the migrations in this repository are numbered `YYYYMMDD` plus a
 *     five digit counter, currently `2026…`. A newly created migration
 *     therefore sorted *before* all 24 existing ones and the next `migrate:up`
 *     failed with "Not run migration … is preceding already run migration …".
 *
 * So: always `.sql`, and a prefix that continues the numbering already in use.
 */
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { getNumericPrefix, listMigrationFilePaths } from "./migration-files";

/** The two section headers the runner splits on. */
const TEMPLATE = "-- Up Migration\n\n-- Down Migration\n";

/**
 * Normalizes a migration name the way the previous CLI did: positional
 * arguments are joined with dashes, and runs of spaces or underscores collapse
 * into a single dash. `create add user index` and `create "add_user index"`
 * both yield `add-user-index`.
 */
export function normalizeMigrationName(nameParts: string[]): string {
  return nameParts.join("-").replace(/[ _]+/g, "-");
}

/**
 * Builds a prefix that sorts after every existing migration.
 *
 * The base is today's `YYYYMMDD` followed by a five digit counter, matching the
 * existing files. Should that land on or below the highest prefix already
 * present — a migration dated today, or one dated in the future — it steps to
 * one past the maximum instead, so the result is always strictly greatest and
 * `migrate:up` can apply it.
 */
export function buildMigrationPrefix(
  existingFileNames: string[],
  now: Date,
): string {
  const year = now.getUTCFullYear();
  const month = `${now.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${now.getUTCDate()}`.padStart(2, "0");

  const highest = existingFileNames.reduce(
    (max, fileName) => Math.max(max, getNumericPrefix(fileName)),
    0,
  );

  const candidate = Number(`${year}${month}${day}00000`);

  return `${candidate > highest ? candidate : highest + 1}`;
}

/** Writes the template and returns the created path. */
export async function createMigration(
  nameParts: string[],
  dir: string,
  now: Date = new Date(),
): Promise<string> {
  const name = normalizeMigrationName(nameParts);

  if (!name) {
    throw new Error("'migrationName' is required.");
  }

  await mkdir(dir, { recursive: true });

  const existing = (await listMigrationFilePaths(dir)).map((path) =>
    basename(path),
  );
  const path = join(dir, `${buildMigrationPrefix(existing, now)}_${name}.sql`);

  await Bun.write(path, TEMPLATE);

  return path;
}
