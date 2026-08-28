import { describe, it, expect } from 'bun:test';
import path from 'path';

const backendRoot = path.resolve(__dirname, '../../..');

/**
 * The exit *status* of a misconfigured process, which `assertStartupEnv`'s own
 * unit tests cannot observe: they assert that it throws, but what a deployment
 * actually depends on is `src/index.ts` turning that throw into a non-zero exit
 * before the server ever listens. Only a real process shows that, so — as in
 * `models/dbBootstrap.test.ts` — each case runs in a subprocess.
 */
const startWith = (env: Record<string, string | undefined>) => {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) childEnv[key] = value;
  }

  const result = Bun.spawnSync(['bun', 'src/index.ts'], {
    cwd: backendRoot,
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
};

// A syntactically valid target that is never reachable: Bun's SQL client
// connects lazily, so nothing here opens a socket.
const UNREACHABLE_DB = 'postgresql://app@database-not-reachable-in-test:5432/appdb';

const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: undefined,
  DATABASE_URL_TEST: undefined,
  JWT_SECRET: undefined,
};

describe('startup exit status', () => {
  it('exits non-zero when production has no signing secret', () => {
    const result = startWith({ ...PRODUCTION, DATABASE_URL: UNREACHABLE_DB });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toInclude('JWT_SECRET is required in production');
    // The check has to land before the socket is open, or a broken deployment
    // starts accepting traffic it cannot serve.
    expect(result.output).not.toInclude('successfully listening');
  });

  it('exits non-zero when no database is configured', () => {
    const result = startWith({ ...PRODUCTION, JWT_SECRET: 'a-real-secret' });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toInclude('No database connection string configured');
    expect(result.output).not.toInclude('successfully listening');
  });

  it('reports the database first when both are missing', () => {
    // Documents a real limit rather than an intention: `assertStartupEnv` does
    // aggregate its fatal problems, but `models/db.ts` throws at import time and
    // `src/index.ts` imports it first, so an operator missing both settings
    // learns about the database, fixes it, and only then hears about
    // JWT_SECRET. Collapsing that into one report means giving db.ts's check to
    // assertStartupEnv, which would change what a non-entrypoint importer (the
    // seed script) does with no database.
    const result = startWith(PRODUCTION);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toInclude('No database connection string configured');
    expect(result.output).not.toInclude('JWT_SECRET is required in production');
  });
});
