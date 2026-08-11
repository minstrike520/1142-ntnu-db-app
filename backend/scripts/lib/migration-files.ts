/**
 * Filesystem and parsing half of the migration runner.
 *
 * Everything here is pure with respect to the database, so the ordering and
 * section-splitting rules that decide *what* runs — and in which order — can be
 * unit tested without a PostgreSQL instance.
 *
 * The rules are deliberately identical to the ones `node-pg-migrate@9` applied
 * to this repository before it was replaced. `pgmigrations` already records 24
 * applied migrations by name on every existing environment, so any divergence
 * in ordering or naming would make a deployed database re-run or skip work.
 */
import { readdir } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

/** Section markers understood inside a `.sql` migration. */
export type MigrationDirection = "up" | "down";

export interface MigrationSections {
  /** SQL of the Up section, or the whole file when no marker is present. */
  up: string;
  /** SQL of the Down section; absent when the file declares no Down section. */
  down?: string;
}

export interface MigrationFile {
  /** Absolute path of the `.sql` file. */
  path: string;
  /** Name recorded in `pgmigrations` — the file name without its extension. */
  name: string;
  sections: MigrationSections;
}

/**
 * Matches `-- Up Migration` / `-- Down Migration` headers, tolerating extra
 * dashes and spacing (`--- up   migration`), case, and leading whitespace.
 */
function createSectionRegex(direction: MigrationDirection): RegExp {
  return new RegExp(`^\\s*--[\\s-]*${direction}\\s+migration`, "im");
}

/**
 * Splits a migration file into its Up and Down SQL.
 *
 * A file with no `Up Migration` header is treated as being entirely Up SQL,
 * which is what lets a bare `.sql` file work without any ceremony. Each section
 * runs to the start of the other one, so the order of the two headers in the
 * file does not matter. Only the *first* occurrence of each header is
 * significant — a later `-- up migration` mentioned inside the Down SQL is just
 * text, not a second section.
 */
export function parseMigrationSections(content: string): MigrationSections {
  const upStart = content.search(createSectionRegex("up"));
  const downStart = content.search(createSectionRegex("down"));

  const up =
    upStart >= 0
      ? content.slice(upStart, downStart < upStart ? undefined : downStart)
      : content;

  const down =
    downStart >= 0
      ? content.slice(downStart, upStart < downStart ? undefined : upStart)
      : undefined;

  return down === undefined ? { up } : { up, down };
}

/**
 * Reads the leading digits of a file name as its ordering key.
 *
 * A 17-digit prefix is an ISO timestamp with milliseconds (`utc` filename
 * format) and is converted to epoch milliseconds so it sorts against the
 * 13-digit `Date.now()` prefixes this repository actually uses. Any other
 * length is read as a plain number.
 */
export function getNumericPrefix(fileName: string): number {
  const prefix = /^\d+/.exec(fileName)?.[0];

  if (!prefix) {
    throw new Error(`Cannot determine numeric prefix for "${fileName}"`);
  }

  if (prefix.length === 17) {
    const year = prefix.slice(0, 4);
    const month = prefix.slice(4, 6);
    const date = prefix.slice(6, 8);
    const hours = prefix.slice(8, 10);
    const minutes = prefix.slice(10, 12);
    const seconds = prefix.slice(12, 14);
    const ms = prefix.slice(14, 17);

    return new Date(
      `${year}-${month}-${date}T${hours}:${minutes}:${seconds}.${ms}Z`,
    ).valueOf();
  }

  return Number(prefix);
}

/**
 * Orders two migration file names: numeric prefix first, then a numeric-aware
 * locale comparison as the tie-breaker. Two files sharing a prefix — this
 * repository has a pair on `2026053000000` — are therefore still totally
 * ordered, and identically to how they were first applied.
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

/** The name a migration is recorded under in `pgmigrations`. */
export function getMigrationName(filePath: string): string {
  return basename(filePath, extname(filePath));
}

/**
 * Lists migration files in `dir`, sorted into application order.
 *
 * Dotfiles are skipped, matching the previous tool's default ignore pattern.
 * Anything else that is not `.sql` is a hard error rather than a silent skip:
 * this runner only understands SQL, so a `.js` or `.ts` migration left in the
 * directory would otherwise be ignored and quietly never applied.
 */
export async function listMigrationFilePaths(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter(
    (entry) =>
      (entry.isFile() || entry.isSymbolicLink()) && !entry.name.startsWith("."),
  );

  const unsupported = files.filter(
    (entry) => extname(entry.name).toLowerCase() !== ".sql",
  );

  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported migration files in ${dir}: ${unsupported
        .map((entry) => entry.name)
        .join(", ")}\n` +
        "This runner executes .sql migrations only. Rewrite them as SQL or " +
        "remove them — leaving them here would silently skip them.",
    );
  }

  return files
    .map((entry) => entry.name)
    .sort(compareMigrationFileNames)
    .map((name) => resolve(dir, name));
}

/** Reads and parses every migration in `dir`, in application order. */
export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const paths = await listMigrationFilePaths(dir);

  return Promise.all(
    paths.map(async (path) => ({
      path,
      name: getMigrationName(path),
      sections: parseMigrationSections(await Bun.file(path).text()),
    })),
  );
}

/**
 * Returns the SQL to execute for one direction, or `undefined` when the section
 * is blank.
 *
 * A section that is only comments is still sent — PostgreSQL accepts it as an
 * empty query — so a migration whose Down section is documented but
 * intentionally a no-op behaves the same as it did before.
 */
export function getExecutableSql(sql: string): string | undefined {
  const trimmed = sql.trim();

  return trimmed.length === 0 ? undefined : trimmed;
}
