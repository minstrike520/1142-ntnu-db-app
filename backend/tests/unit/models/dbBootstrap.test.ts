import { describe, it, expect } from 'bun:test';
import path from 'path';

const backendRoot = path.resolve(__dirname, '../../..');

/**
 * db.ts is evaluated once per process, so its bootstrap behaviour has to be
 * exercised in a subprocess rather than by re-importing it here.
 */
const importDbWith = (env: Record<string, string | undefined>) => {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) childEnv[key] = value;
  }

  const result = Bun.spawnSync(
    ['bun', '-e', 'await import("./src/models/db"); console.log("IMPORT_OK");'],
    { cwd: backendRoot, env: childEnv, stdout: 'pipe', stderr: 'pipe' },
  );

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

const NO_DB_ENV = { DATABASE_URL: undefined, DATABASE_URL_TEST: undefined };

describe('db bootstrap', () => {
  it('imports without any database configured under the test runner', () => {
    // The unit-tests CI job runs with no database at all; throwing here broke
    // every suite that transitively imports this module.
    const result = importDbWith({ ...NO_DB_ENV, NODE_ENV: 'test' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toInclude('IMPORT_OK');
  });

  it('fails fast when a non-test environment has no database configured', () => {
    const result = importDbWith({ ...NO_DB_ENV, NODE_ENV: 'production' });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toInclude('No database connection string configured');
  });

  it('prefers DATABASE_URL_TEST only under NODE_ENV=test', () => {
    const env = {
      DATABASE_URL: 'postgresql://app:pw@primary-host:5432/appdb',
      DATABASE_URL_TEST: 'postgresql://test:pw@test-host:5432/testdb',
    };

    expect(importDbWith({ ...env, NODE_ENV: 'test' }).stdout).toInclude('test-host:5432/testdb');
    expect(importDbWith({ ...env, NODE_ENV: 'development' }).stdout).toInclude('primary-host:5432/appdb');
  });

  it('never prints credentials on startup', () => {
    const result = importDbWith({
      DATABASE_URL: 'postgresql://appuser:sup3r-s3cret@primary-host:5432/appdb',
      DATABASE_URL_TEST: undefined,
      NODE_ENV: 'development',
    });

    expect(result.stdout).not.toInclude('sup3r-s3cret');
    expect(result.stdout).not.toInclude('appuser');
  });
});
