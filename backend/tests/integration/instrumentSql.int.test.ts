import { describe, it, expect, afterAll } from 'bun:test';
import { SQL } from 'bun';
import {
  DEFAULT_SLOW_QUERY_THRESHOLD_MS,
  instrumentSql,
} from '../../src/models/instrumentSql';
import { createSlowQueryStore, type SlowQueryStore } from '../../src/utils/slowQueryStore';
import { createLogger, createRecentLogStore } from '../../src/utils/logger';

/**
 * The instrumentation wraps Bun's own `SQL` client, so the properties that
 * matter most about it are properties of Bun and PostgreSQL rather than of our
 * code: that a `Query` does not start running until it is awaited, that a
 * statement inside `begin()` runs on a different handle, and that a genuinely
 * slow statement is caught. A fake client cannot speak for any of those, which
 * is why they are asserted here against a live database; the unit suite covers
 * the parts that are pure logic.
 */
describe('instrumentSql (pg)', () => {
  const connectionString = process.env.DATABASE_URL_TEST;
  if (!connectionString) {
    throw new Error('DATABASE_URL_TEST is not set — copy .env.test.example to .env.test');
  }

  const raw = new SQL(connectionString);
  const store: SlowQueryStore = createSlowQueryStore({ capacity: 10 });
  const logStore = createRecentLogStore({ capacity: 50 });
  const logger = createLogger({
    level: 'warn',
    pretty: false,
    store: logStore,
    stdout: { write: () => true } as unknown as NodeJS.WritableStream,
  });
  const sql = instrumentSql(raw, { logger, store });

  /** Comfortably past the 100 ms threshold without making the suite slow. */
  const SLOW_SECONDS = 0.15;

  afterAll(async () => {
    await raw.end();
  });

  it('leaves a fast query unrecorded and its result unchanged', async () => {
    const before = store.size();

    expect(await sql<{ n: number }[]>`SELECT 1 AS n`).toEqual([{ n: 1 }]);
    expect(store.size()).toBe(before);
  });

  it('records a genuinely slow statement with its real duration', async () => {
    const before = store.size();

    await sql`SELECT pg_sleep(${SLOW_SECONDS})`;

    expect(store.size()).toBe(before + 1);
    const [record] = store.recent(1);
    expect(record.query).toBe('SELECT pg_sleep( ? )');
    expect(record.durationMs).toBeGreaterThan(DEFAULT_SLOW_QUERY_THRESHOLD_MS);
    expect(record.durationMs).toBeLessThan(SLOW_SECONDS * 1000 + 5_000);
  });

  it('keeps bound values out of the record and the log line', async () => {
    const secret = 'super-secret-value-not-for-logs';

    await sql`SELECT pg_sleep(${SLOW_SECONDS}), ${secret}::text AS v`;

    const written = JSON.stringify([store.recent(), logStore.recent()]);
    expect(written).not.toContain(secret);
    expect(store.recent(1)[0].query).toContain('?');
  });

  it('measures statements run inside a transaction', async () => {
    const before = store.size();

    await sql.begin(async (tx) => {
      await tx`SELECT pg_sleep(${SLOW_SECONDS})`;
    });

    expect(store.size()).toBe(before + 1);
    expect(store.recent(1)[0].query).toBe('SELECT pg_sleep( ? )');
  });

  it('does not charge a query for the time before it was awaited', async () => {
    const before = store.size();

    // Bun's Query is lazy: this has not run yet, so the wait that follows is not
    // this query's latency and must not be reported as such.
    const query = sql`SELECT 1`;
    await new Promise((resolve) => setTimeout(resolve, DEFAULT_SLOW_QUERY_THRESHOLD_MS * 2));
    await query;

    expect(store.size()).toBe(before);
  });

  it('propagates a failing statement to the caller', async () => {
    let caught: unknown;
    try {
      await sql`SELECT * FROM a_table_that_does_not_exist`;
    } catch (error) {
      caught = error;
    }

    expect((caught as Error | undefined)?.message).toContain('a_table_that_does_not_exist');
  });

  it('still supports the identifier-fragment helper through the proxy', async () => {
    const rows = await sql<{ n: number }[]>`SELECT 1 AS ${sql('n')}`;

    expect(rows).toEqual([{ n: 1 }]);
  });
});
