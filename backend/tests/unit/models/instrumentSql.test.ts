import { describe, it, expect } from 'bun:test';
import type { SQL } from 'bun';
import {
  DEFAULT_SLOW_QUERY_THRESHOLD_MS,
  MAX_QUERY_TEXT_CHARS,
  describeQuery,
  instrumentSql,
} from '../../../src/models/instrumentSql';
import { createSlowQueryStore, type SlowQueryStore } from '../../../src/utils/slowQueryStore';
import { createLogger, createRecentLogStore, type RecentLogEntry } from '../../../src/utils/logger';

/**
 * Stands in for `Bun.SQL`: a callable that returns a lazily-executing thenable,
 * which is the only shape of Bun's `Query` the instrumentation actually touches.
 * The behaviours a fake cannot speak for — real transactions, real laziness,
 * Bun's own `Query` internals — are covered by
 * `tests/integration/instrumentSql.int.test.ts` against a live PostgreSQL.
 */
const createFakeSql = (
  behaviour: { result?: unknown; error?: unknown } = {},
): { sql: SQL; calls: unknown[][]; thenCalls: () => number } => {
  const calls: unknown[][] = [];
  let thenCalls = 0;

  const fake = (...args: unknown[]) => {
    calls.push(args);
    return {
      then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        thenCalls += 1;
        return behaviour.error !== undefined
          ? Promise.reject(behaviour.error).then(onFulfilled, onRejected)
          : Promise.resolve(behaviour.result ?? [{ ok: true }]).then(onFulfilled, onRejected);
      },
    };
  };

  return { sql: fake as unknown as SQL, calls, thenCalls: () => thenCalls };
};

/** A logger whose records land in a buffer instead of the test runner's output. */
const createTestLogger = () => {
  const store = createRecentLogStore({ capacity: 50 });
  const logger = createLogger({
    level: 'warn',
    pretty: false,
    store,
    stdout: { write: () => true } as unknown as NodeJS.WritableStream,
  });
  return {
    logger,
    warnings: (): RecentLogEntry[] =>
      store.recent().filter((entry) => entry.msg === 'slow query'),
  };
};

/** Advances by a fixed amount per read, so a measured duration is exact. */
const stepClock = (stepMs: number) => {
  let current = 0;
  return () => {
    const value = current;
    current += stepMs;
    return value;
  };
};

const setup = (
  stepMs: number,
  behaviour: { result?: unknown; error?: unknown } = {},
): {
  sql: SQL;
  store: SlowQueryStore;
  warnings: () => RecentLogEntry[];
  calls: unknown[][];
  thenCalls: () => number;
} => {
  const { sql: fake, calls, thenCalls } = createFakeSql(behaviour);
  const store = createSlowQueryStore({ capacity: 10 });
  const { logger, warnings } = createTestLogger();
  const sql = instrumentSql(fake, { logger, store, now: stepClock(stepMs) });
  return { sql, store, warnings, calls, thenCalls };
};

describe('describeQuery', () => {
  it('replaces every interpolation hole with a placeholder', () => {
    expect(describeQuery(['SELECT * FROM users WHERE user_id = ', ' AND deleted_at IS NULL'])).toBe(
      'SELECT * FROM users WHERE user_id = ? AND deleted_at IS NULL',
    );
  });

  it('collapses the whitespace a multi-line template carries', () => {
    expect(describeQuery(['\n      SELECT 1\n      FROM users\n    '])).toBe('SELECT 1 FROM users');
  });

  it('truncates a query too large to be worth retaining', () => {
    const described = describeQuery([`SELECT ${'x'.repeat(MAX_QUERY_TEXT_CHARS * 2)}`]);

    expect(described.length).toBe(MAX_QUERY_TEXT_CHARS + 1);
    expect(described.endsWith('…')).toBe(true);
  });
});

describe('instrumentSql', () => {
  it('returns the query result untouched', async () => {
    const { sql } = setup(1, { result: [{ userId: 'u1' }] });

    expect(await sql<{ userId: string }[]>`SELECT * FROM users`).toEqual([{ userId: 'u1' }]);
  });

  it('leaves a query under the threshold unrecorded', async () => {
    const { sql, store, warnings } = setup(DEFAULT_SLOW_QUERY_THRESHOLD_MS - 1);

    await sql`SELECT 1`;

    expect(store.size()).toBe(0);
    expect(warnings()).toHaveLength(0);
  });

  it('does not record a query that sits exactly on the threshold', async () => {
    const { sql, store } = setup(DEFAULT_SLOW_QUERY_THRESHOLD_MS);

    await sql`SELECT 1`;

    expect(store.size()).toBe(0);
  });

  it('records a slow query and warns, with the query shape but no bound values', async () => {
    const { sql, store, warnings } = setup(150);
    const email = 'alice@test.com';

    await sql`SELECT * FROM users WHERE email = ${email}`;

    expect(store.recent()).toHaveLength(1);
    const [record] = store.recent();
    expect(record.query).toBe('SELECT * FROM users WHERE email = ?');
    expect(record.durationMs).toBe(150);
    expect(record.at).toBeGreaterThan(0);

    expect(warnings()).toHaveLength(1);
    // pino's numeric levels: 40 is warn.
    expect(warnings()[0]).toMatchObject({ level: 40, durationMs: 150 });

    expect(JSON.stringify([store.recent(), warnings()])).not.toContain(email);
  });

  it('measures a query that failed slowly and re-throws it untouched', async () => {
    const failure = new Error('statement timeout');
    const { sql, store } = setup(150, { error: failure });

    // Awaited through try/catch rather than `expect().rejects`, which wants a
    // real Promise: what the caller gets back here is Bun's thenable Query.
    let caught: unknown;
    try {
      await sql`SELECT * FROM messages`;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(store.recent()[0]?.query).toBe('SELECT * FROM messages');
  });

  it('measures a query awaited twice only once', async () => {
    const { sql, store } = setup(150);

    const query = sql`SELECT 1`;
    await query;
    await query;

    expect(store.size()).toBe(1);
  });

  it('passes a helper call straight through, since a fragment never executes', async () => {
    const { sql, store, calls, thenCalls } = setup(150);

    // `sql('users')` builds an identifier fragment for interpolation. Bun returns
    // the same Query type as a statement does, so timing it would report a
    // duration for something that never ran.
    const fragment = (sql as unknown as (name: string) => unknown)('users');
    await sql`SELECT 1 FROM ${fragment as never}`;

    expect(calls[0]).toEqual(['users']);
    expect(store.recent().map((record) => record.query)).toEqual(['SELECT 1 FROM ?']);
    expect(thenCalls()).toBe(1);
  });

  it('never lets a failing store or logger fail the query it is measuring', async () => {
    const { sql: fake } = createFakeSql({ result: [{ ok: true }] });
    const exploding: SlowQueryStore = {
      capacity: 1,
      size: () => 0,
      recent: () => [],
      push: () => {
        throw new Error('store is broken');
      },
    };
    const sql = instrumentSql(fake, {
      store: exploding,
      logger: createTestLogger().logger,
      now: stepClock(150),
    });

    expect(await sql<{ ok: boolean }[]>`SELECT 1`).toEqual([{ ok: true }]);
  });

  it('instruments the handle a transaction hands its callback', async () => {
    const { sql: fake } = createFakeSql();
    const store = createSlowQueryStore({ capacity: 10 });
    const { logger } = createTestLogger();

    // Stand in for Bun's `begin`, which invokes the callback with its own
    // callable client — the object statements inside a transaction run on.
    const txClient = createFakeSql().sql;
    (fake as unknown as { begin: unknown }).begin = (
      callback: (tx: SQL) => Promise<unknown>,
    ): Promise<unknown> => callback(txClient);

    const sql = instrumentSql(fake, { logger, store, now: stepClock(150) });
    await (sql.begin as (cb: (tx: SQL) => Promise<unknown>) => Promise<unknown>)(async (tx) => {
      await tx`UPDATE room_members SET role = ${'admin'}`;
    });

    expect(store.recent().map((record) => record.query)).toEqual([
      'UPDATE room_members SET role = ?',
    ]);
  });

  it('measures an unsafe statement, which is how dynamic updates are written', async () => {
    const { sql: fake } = createFakeSql();
    const store = createSlowQueryStore({ capacity: 10 });
    const { logger } = createTestLogger();
    const seen: unknown[][] = [];

    // Mirrors `UserRepository.update()`: a SET list assembled at runtime, with
    // the values passed separately as `$n` parameters.
    (fake as unknown as { unsafe: unknown }).unsafe = (...args: unknown[]) => {
      seen.push(args);
      return {
        then: (onFulfilled?: (v: unknown) => unknown) => Promise.resolve([]).then(onFulfilled),
      };
    };

    const sql = instrumentSql(fake, { logger, store, now: stepClock(150) });
    const text = 'UPDATE users SET bio = $1, app_theme = $2 WHERE user_id = $3 RETURNING *';
    await (sql.unsafe as (text: string, values: unknown[]) => Promise<unknown>)(text, [
      'a bio',
      'dark',
      'user-1',
    ]);

    expect(store.recent().map((record) => record.query)).toEqual([text]);
    // The bound values stay in the argument this code never reads.
    expect(JSON.stringify(store.recent())).not.toContain('a bio');
    expect(seen[0]?.[1]).toEqual(['a bio', 'dark', 'user-1']);
  });

  it('forwards a method that is not a query to the underlying client', async () => {
    const { sql: fake } = createFakeSql();
    let closed = 0;
    (fake as unknown as { close: unknown }).close = () => {
      closed += 1;
      return Promise.resolve();
    };

    const sql = instrumentSql(fake, { store: createSlowQueryStore(), now: stepClock(150) });
    await (sql.close as () => Promise<void>)();

    expect(closed).toBe(1);
  });
});
