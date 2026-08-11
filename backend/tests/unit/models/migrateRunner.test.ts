import { describe, it, expect } from 'bun:test';
import path from 'path';
import {
  assertMigrationOrder,
  compareMigrationFileNames,
  getNumericPrefix,
  loadMigrationFiles,
  splitMigrationSql,
} from '../../../src/models/migrate';

const migrationsDir = path.resolve(__dirname, '../../../migrations');

/**
 * These helpers decide which SQL runs against a production database and in what
 * order, so they are pinned against node-pg-migrate v9's observed behaviour.
 * Diverging here does not fail loudly — it silently re-runs or skips migrations
 * on an already-deployed stack.
 */
describe('getNumericPrefix', () => {
  it('reads the digits before the first separator', () => {
    expect(getNumericPrefix('1716300000000_init.sql')).toBe(1716300000000);
  });

  it('treats a 17-digit prefix as a UTC timestamp, as node-pg-migrate does', () => {
    expect(getNumericPrefix('20260530120000123_thing.sql')).toBe(
      new Date('2026-05-30T12:00:00.123Z').valueOf(),
    );
  });

  it('rejects a file with no numeric prefix rather than sorting it arbitrarily', () => {
    expect(() => getNumericPrefix('no_prefix.sql')).toThrow(/Cannot determine numeric prefix/);
  });
});

describe('compareMigrationFileNames', () => {
  it('orders by numeric prefix, not lexicographically', () => {
    // Lexicographic order would put the 9-prefixed file last.
    expect(
      ['2026053014000_b.sql', '999_a.sql'].sort(compareMigrationFileNames),
    ).toEqual(['999_a.sql', '2026053014000_b.sql']);
  });

  it('breaks a shared prefix the way node-pg-migrate does', () => {
    // These two really share a prefix in migrations/, and the applied order is
    // recorded in pgmigrations — swapping them would rewrite deployed history.
    expect(
      [
        '2026053000000_emergency_contacts.sql',
        '2026053000000_create-friendships-and-blocks.sql',
      ].sort(compareMigrationFileNames),
    ).toEqual([
      '2026053000000_create-friendships-and-blocks.sql',
      '2026053000000_emergency_contacts.sql',
    ]);
  });
});

describe('splitMigrationSql', () => {
  const content = [
    '--- Up migration',
    'CREATE TABLE t (a int);',
    '',
    '--- Down migration',
    'DROP TABLE t;',
  ].join('\n');

  it('keeps each marker comment attached to the SQL it introduces', () => {
    const { up, down } = splitMigrationSql(content);

    expect(up).toStartWith('--- Up migration');
    expect(up).toInclude('CREATE TABLE t (a int);');
    expect(up).not.toInclude('DROP TABLE');

    // The marker regex is anchored with `^\s*`, so a blank line before the
    // marker is absorbed into the down half. node-pg-migrate slices the same
    // way, and leading whitespace is inert SQL.
    expect(down?.trimStart()).toStartWith('--- Down migration');
    expect(down).toInclude('DROP TABLE t;');
    expect(down).not.toInclude('CREATE TABLE');
  });

  it('accepts the marker spellings node-pg-migrate accepts', () => {
    const { up, down } = splitMigrationSql('-- UP MIGRATION\nSELECT 1;\n--- down   migration\nSELECT 2;');

    expect(up).toInclude('SELECT 1;');
    expect(down).toInclude('SELECT 2;');
  });

  it('reports a missing down section instead of guessing one', () => {
    expect(splitMigrationSql('--- Up migration\nSELECT 1;').down).toBeNull();
  });

  it('treats an unmarked file as up-only', () => {
    const { up, down } = splitMigrationSql('SELECT 1;');

    expect(up).toBe('SELECT 1;');
    expect(down).toBeNull();
  });
});

describe('assertMigrationOrder', () => {
  it('accepts pending migrations appended after the applied ones', () => {
    expect(() => assertMigrationOrder(['1_a', '2_b'], ['1_a', '2_b', '3_c'])).not.toThrow();
  });

  it('rejects a new migration that sorts before an already applied one', () => {
    expect(() => assertMigrationOrder(['2_b'], ['1_a', '2_b'])).toThrow(
      'Not run migration 1_a is preceding already run migration 2_b',
    );
  });
});

describe('loadMigrationFiles', () => {
  it('returns every migration in the repository, sorted, named as pgmigrations records them', async () => {
    const migrations = await loadMigrationFiles();
    const names = migrations.map((migration) => migration.name);

    expect(names).toEqual([...names].sort(compareMigrationFileNames));
    expect(names).toContain('1716300000000_init');
    // The recorded name is the basename without the extension.
    expect(names.every((name) => !name.endsWith('.sql'))).toBe(true);
    expect(migrations[0]?.filePath).toBe(path.join(migrationsDir, '1716300000000_init.sql'));
  });

  it('every migration in the repository is splittable and reversible', async () => {
    for (const migration of await loadMigrationFiles()) {
      const { up, down } = splitMigrationSql(await Bun.file(migration.filePath).text());

      expect(up.trim().length, `${migration.name} has an empty up section`).toBeGreaterThan(0);
      expect(down, `${migration.name} has no down section`).not.toBeNull();
    }
  });

  it('refuses a non-SQL migration rather than sending it to the database', async () => {
    const dir = path.join(__dirname, 'fixtures-migrate-runner');

    await Bun.write(path.join(dir, '1_ok.sql'), '--- Up migration\nSELECT 1;');
    await Bun.write(path.join(dir, '2_unsupported.ts'), 'export const up = () => {};');

    try {
      await expect(loadMigrationFiles(dir)).rejects.toThrow(/Only \.sql migrations are supported/);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });
});
