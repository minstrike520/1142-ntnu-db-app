import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compareMigrationFileNames,
  getExecutableSql,
  getMigrationName,
  getNumericPrefix,
  listMigrationFilePaths,
  loadMigrationFiles,
  parseMigrationSections,
} from '../../../scripts/lib/migration-files';
import {
  buildMigrationPrefix,
  createMigration,
  normalizeMigrationName,
} from '../../../scripts/lib/create-migration';

/**
 * These rules decide which migrations run and in what order, against databases
 * that already have 24 of them recorded by name. Getting them wrong re-runs or
 * skips schema changes on a deployed environment, so they are pinned here
 * rather than only exercised end to end against a live database.
 */
describe('parseMigrationSections', () => {
  it('splits a file on its Up and Down headers', () => {
    const sections = parseMigrationSections(
      '-- Up Migration\nCREATE TABLE t (a int);\n-- Down Migration\nDROP TABLE t;\n',
    );

    expect(sections.up).toContain('CREATE TABLE t (a int);');
    expect(sections.up).not.toContain('DROP TABLE t;');
    expect(sections.down).toContain('DROP TABLE t;');
    expect(sections.down).not.toContain('CREATE TABLE t (a int);');
  });

  it('accepts extra dashes, casing and spacing in the headers', () => {
    const sections = parseMigrationSections(
      '--- up   migration\nSELECT 1;\n----DOWN\tmigration\nSELECT 2;\n',
    );

    expect(sections.up).toContain('SELECT 1;');
    expect(sections.down).toContain('SELECT 2;');
  });

  it('splits correctly when Down comes before Up', () => {
    const sections = parseMigrationSections(
      '-- Down Migration\nDROP TABLE t;\n-- Up Migration\nCREATE TABLE t (a int);\n',
    );

    expect(sections.up).toContain('CREATE TABLE t (a int);');
    expect(sections.up).not.toContain('DROP TABLE t;');
    expect(sections.down).toContain('DROP TABLE t;');
    expect(sections.down).not.toContain('CREATE TABLE t (a int);');
  });

  it('treats a file with no headers as entirely Up SQL', () => {
    const sections = parseMigrationSections('CREATE TABLE t (a int);');

    expect(sections.up).toBe('CREATE TABLE t (a int);');
    expect(sections.down).toBeUndefined();
  });

  it('ignores a header mentioned again inside a section', () => {
    // Two migrations in this repository repeat a header word in prose. Only the
    // first occurrence of each may start a section.
    const sections = parseMigrationSections(
      '-- Up Migration\nSELECT 1;\n-- the up migration above is idempotent\n-- Down Migration\nSELECT 2;\n',
    );

    expect(sections.up).toContain('SELECT 1;');
    expect(sections.up).toContain('idempotent');
    expect(sections.down).toContain('SELECT 2;');
    expect(sections.down).not.toContain('SELECT 1;');
  });

  it('reports no Down section when the file has none', () => {
    const sections = parseMigrationSections('-- Up Migration\nSELECT 1;\n');

    expect(sections.down).toBeUndefined();
  });
});

describe('getNumericPrefix', () => {
  it('reads the leading digits of a file name', () => {
    expect(getNumericPrefix('2026081000006_enforce.sql')).toBe(2026081000006);
    expect(getNumericPrefix('1716300000000_init.sql')).toBe(1716300000000);
  });

  it('reads a 17 digit prefix as a UTC timestamp', () => {
    expect(getNumericPrefix('20260810123456789_x.sql')).toBe(
      Date.UTC(2026, 7, 10, 12, 34, 56, 789),
    );
  });

  it('rejects a file name with no numeric prefix', () => {
    expect(() => getNumericPrefix('init.sql')).toThrow(
      'Cannot determine numeric prefix',
    );
  });
});

describe('compareMigrationFileNames', () => {
  it('orders by numeric prefix, not lexically', () => {
    // Lexically "1716..." > "999..." would be wrong; numerically it is not.
    expect(
      compareMigrationFileNames('999_early.sql', '1716300000000_init.sql'),
    ).toBeLessThan(0);
  });

  it('breaks a shared prefix by name', () => {
    // This exact pair exists in the repository and must keep the order it was
    // first applied in.
    expect(
      compareMigrationFileNames(
        '2026053000000_create-friendships-and-blocks.sql',
        '2026053000000_emergency_contacts.sql',
      ),
    ).toBeLessThan(0);
  });
});

describe('getMigrationName', () => {
  it('strips the extension to produce the recorded name', () => {
    expect(getMigrationName('/a/b/2026081000006_enforce.sql')).toBe(
      '2026081000006_enforce',
    );
  });
});

describe('getExecutableSql', () => {
  it('returns trimmed SQL', () => {
    expect(getExecutableSql('\n  SELECT 1;\n')).toBe('SELECT 1;');
  });

  it('returns undefined for a blank section', () => {
    expect(getExecutableSql('   \n\n')).toBeUndefined();
  });
});

describe('migration directory listing', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'migration-files-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sorts by prefix and skips dotfiles', async () => {
    await writeFile(join(dir, '2026081000001_second.sql'), '-- Up Migration\n');
    await writeFile(join(dir, '999_first.sql'), '-- Up Migration\n');
    await writeFile(join(dir, '.keep'), '');
    await mkdir(join(dir, 'nested'), { recursive: true });

    const paths = await listMigrationFilePaths(dir);

    expect(paths.map((path) => basename(path))).toEqual([
      '999_first.sql',
      '2026081000001_second.sql',
    ]);
  });

  it('refuses to run when a non-SQL migration is present', async () => {
    const jsPath = join(dir, '2026081000002_legacy.js');
    await writeFile(jsPath, 'exports.up = () => {};');

    // Silently skipping it would leave a migration permanently unapplied.
    await expect(listMigrationFilePaths(dir)).rejects.toThrow(
      'Unsupported migration files',
    );

    await rm(jsPath);
  });

  it('loads names and sections together', async () => {
    const migrations = await loadMigrationFiles(dir);

    expect(migrations.map((migration) => migration.name)).toEqual([
      '999_first',
      '2026081000001_second',
    ]);
    expect(migrations[0]?.sections.up).toContain('Up Migration');
  });
});

describe('normalizeMigrationName', () => {
  it('joins parts with dashes and collapses spaces and underscores', () => {
    expect(normalizeMigrationName(['add', 'user', 'index'])).toBe(
      'add-user-index',
    );
    expect(normalizeMigrationName(['add_user  index'])).toBe('add-user-index');
  });

  it('returns an empty string when no parts are given', () => {
    expect(normalizeMigrationName([])).toBe('');
  });
});

describe('buildMigrationPrefix', () => {
  const existing = [
    '1716300000000_init.sql',
    '2026081000006_enforce_blocked_private_room_state.sql',
  ];

  it('uses todays date and sorts after every existing migration', () => {
    const prefix = buildMigrationPrefix(existing, new Date('2026-08-11T09:00:00Z'));

    expect(prefix).toBe('2026081100000');
    expect(getNumericPrefix(prefix)).toBeGreaterThan(2026081000006);
  });

  it('steps past the highest prefix when the date collides', () => {
    // A second migration created the same day, or a migration already dated in
    // the future, must still sort last rather than tie or fall behind.
    const prefix = buildMigrationPrefix(
      [...existing, '2026081100000_first_today.sql'],
      new Date('2026-08-11T09:00:00Z'),
    );

    expect(prefix).toBe('2026081100001');
  });

  it('steps past a future-dated migration', () => {
    const prefix = buildMigrationPrefix(
      [...existing, '2027010100000_from_the_future.sql'],
      new Date('2026-08-11T09:00:00Z'),
    );

    expect(getNumericPrefix(prefix)).toBeGreaterThan(2027010100000);
  });
});

describe('createMigration', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'create-migration-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a .sql template that parses into both sections', async () => {
    const path = await createMigration(['add', 'thing'], dir);

    expect(basename(path)).toMatch(/^\d+_add-thing\.sql$/);

    const sections = parseMigrationSections(await Bun.file(path).text());

    // Both sections must exist, and both must hold nothing but their header
    // comment, so `up` then `down` on a freshly created migration is a no-op
    // rather than an error. PostgreSQL accepts a comment-only query.
    expect(sections.up).toBeDefined();
    expect(sections.down).toBeDefined();

    for (const section of [sections.up, sections.down as string]) {
      const statements = section
        .split('\n')
        .filter((line) => line.trim().length > 0 && !line.trim().startsWith('--'));

      expect(statements).toEqual([]);
    }
  });

  it('requires a name', async () => {
    await expect(createMigration([], dir)).rejects.toThrow(
      "'migrationName' is required.",
    );
  });
});
