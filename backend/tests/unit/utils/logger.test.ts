import { describe, it, expect } from 'bun:test';
import { Writable } from 'node:stream';
import {
  DEFAULT_RECENT_LOG_CAPACITY,
  createLogger,
  createRecentLogStore,
  resolveLogLevel,
  shouldPrettyPrint,
  type RecentLogStore,
} from '../../../src/utils/logger';

/**
 * Stands in for stdout so the logger under test writes into an array instead of
 * the test runner's output.
 */
const createCapturingStream = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { stream, lines };
};

/** `n` serialized records, numbered so ordering and eviction are checkable. */
const pushRecords = (store: RecentLogStore, from: number, to: number): void => {
  for (let n = from; n <= to; n += 1) {
    store.push(JSON.stringify({ level: 30, time: 1_700_000_000_000 + n, msg: `record-${n}` }));
  }
};

const messages = (store: RecentLogStore, limit?: number): (string | undefined)[] =>
  store.recent(limit).map((entry) => entry.msg);

describe('createRecentLogStore', () => {
  it('rejects a capacity that could not bound anything', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createRecentLogStore({ capacity })).toThrow(RangeError);
    }
  });

  it('rejects a non-positive-integer maxEntryChars', () => {
    for (const maxEntryChars of [0, -1, 2.5, Number.NaN]) {
      expect(() => createRecentLogStore({ maxEntryChars })).toThrow(RangeError);
    }
  });

  it('returns nothing when empty', () => {
    const store = createRecentLogStore({ capacity: 3 });
    expect(store.recent()).toEqual([]);
    expect(store.size()).toBe(0);
    expect(store.capacity).toBe(3);
  });

  it('keeps every record while below capacity, oldest first', () => {
    const store = createRecentLogStore({ capacity: 5 });
    pushRecords(store, 1, 3);

    expect(store.size()).toBe(3);
    expect(messages(store)).toEqual(['record-1', 'record-2', 'record-3']);
  });

  it('keeps exactly the newest N once capacity is reached and then exceeded', () => {
    const store = createRecentLogStore({ capacity: 3 });

    pushRecords(store, 1, 3);
    expect(messages(store)).toEqual(['record-1', 'record-2', 'record-3']);

    // One past capacity evicts exactly one record: the oldest.
    pushRecords(store, 4, 4);
    expect(store.size()).toBe(3);
    expect(messages(store)).toEqual(['record-2', 'record-3', 'record-4']);
  });

  it('stays ordered after several wraparound laps that do not land on a multiple of capacity', () => {
    // 17 writes over a capacity of 5 is three full laps plus two — ordering bugs
    // in the modulo read path survive lap one and exact multiples, not this.
    const store = createRecentLogStore({ capacity: 5 });
    pushRecords(store, 1, 17);

    expect(store.size()).toBe(5);
    expect(messages(store)).toEqual([
      'record-13',
      'record-14',
      'record-15',
      'record-16',
      'record-17',
    ]);
  });

  it('does not grow unbounded: 10x capacity of writes still yields only the newest capacity records', () => {
    const capacity = DEFAULT_RECENT_LOG_CAPACITY;
    const store = createRecentLogStore({ capacity });
    const total = capacity * 10;

    pushRecords(store, 1, total);

    const entries = store.recent();
    expect(entries).toHaveLength(capacity);
    expect(store.size()).toBe(capacity);
    // The window is the last `capacity` records, in order...
    expect(entries[0].msg).toBe(`record-${total - capacity + 1}`);
    expect(entries[entries.length - 1].msg).toBe(`record-${total}`);
    // ...and the very first record is provably gone.
    expect(entries.some((entry) => entry.msg === 'record-1')).toBe(false);
  });

  it('never reports a size above its capacity', () => {
    const store = createRecentLogStore({ capacity: 4 });
    for (let n = 1; n <= 40; n += 1) {
      pushRecords(store, n, n);
      expect(store.size()).toBeLessThanOrEqual(4);
    }
    expect(store.size()).toBe(4);
  });

  it('honours a limit smaller than, equal to, and larger than what it holds', () => {
    const store = createRecentLogStore({ capacity: 5 });
    pushRecords(store, 1, 5);

    expect(messages(store, 2)).toEqual(['record-4', 'record-5']);
    expect(messages(store, 5)).toEqual(['record-1', 'record-2', 'record-3', 'record-4', 'record-5']);
    // Asking for more than exists yields what exists rather than padding.
    expect(messages(store, 500)).toHaveLength(5);
  });

  it('treats a zero, negative or fractional limit as a request for that many at most', () => {
    const store = createRecentLogStore({ capacity: 5 });
    pushRecords(store, 1, 5);

    expect(store.recent(0)).toEqual([]);
    expect(store.recent(-3)).toEqual([]);
    expect(messages(store, 2.9)).toEqual(['record-4', 'record-5']);
    expect(store.recent(Number.NaN)).toHaveLength(5);
  });

  it('hands back a fresh array and fresh entries each call', () => {
    const store = createRecentLogStore({ capacity: 3 });
    pushRecords(store, 1, 2);

    const first = store.recent();
    first.push({ level: 30, time: 0, msg: 'injected' });
    (first[0] as { msg: string }).msg = 'mutated';

    // Neither the array nor the entry the caller mutated is the buffer's own.
    expect(messages(store)).toEqual(['record-1', 'record-2']);
  });

  it('replaces an oversized record with a bounded stand-in', () => {
    const store = createRecentLogStore({ capacity: 2, maxEntryChars: 128 });
    store.push(JSON.stringify({ level: 30, time: 1, msg: 'x'.repeat(500) }));

    const [entry] = store.recent();
    expect(entry.level).toBe(0);
    expect(entry.msg).toContain('too large to retain');
    expect(entry.maxEntryChars).toBe(128);
    expect(entry.droppedChars).toBeGreaterThan(128);
  });

  it('surfaces an unparsable record instead of dropping or throwing on it', () => {
    const store = createRecentLogStore({ capacity: 2 });
    store.push('this is not json');

    const [entry] = store.recent();
    expect(entry.level).toBe(0);
    expect(entry.time).toBe(0);
    expect(entry.msg).toBe('this is not json');
  });
});

describe('resolveLogLevel', () => {
  it('uses LOG_LEVEL when it names a real level, case- and space-insensitively', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'debug' })).toBe('debug');
    expect(resolveLogLevel({ LOG_LEVEL: '  WARN ' })).toBe('warn');
    expect(resolveLogLevel({ LOG_LEVEL: 'silent' })).toBe('silent');
  });

  it('falls back rather than handing pino a level it would throw on', () => {
    // pino throws on an unknown level, and this module builds a logger at import
    // time, so a typo here would otherwise be a boot crash.
    for (const value of ['verbose', 'INFOO', '30', '']) {
      expect(resolveLogLevel({ LOG_LEVEL: value })).toBe('info');
    }
    expect(() => createLogger({ level: resolveLogLevel({ LOG_LEVEL: 'verbose' }) })).not.toThrow();
  });

  it('defaults to silent under the test runner and info elsewhere', () => {
    expect(resolveLogLevel({ NODE_ENV: 'test' })).toBe('silent');
    expect(resolveLogLevel({ NODE_ENV: 'production' })).toBe('info');
    expect(resolveLogLevel({})).toBe('info');
    // An explicit LOG_LEVEL still wins under test.
    expect(resolveLogLevel({ NODE_ENV: 'test', LOG_LEVEL: 'error' })).toBe('error');
  });
});

describe('shouldPrettyPrint', () => {
  it('opts in only for development, never by excluding production', () => {
    expect(shouldPrettyPrint({ NODE_ENV: 'development' })).toBe(true);
    expect(shouldPrettyPrint({ NODE_ENV: 'production' })).toBe(false);
    expect(shouldPrettyPrint({ NODE_ENV: 'test' })).toBe(false);
    // docker-compose.prod.yml passes `NODE_ENV=${NODE_ENV}`, and Compose turns an
    // unset variable into the empty string, overriding the image's own value.
    // A `!== 'production'` test would select the pretty path there and reach for
    // a devDependency the production image does not install.
    expect(shouldPrettyPrint({ NODE_ENV: '' })).toBe(false);
    expect(shouldPrettyPrint({})).toBe(false);
  });
});

describe('createLogger', () => {
  it('writes each record to stdout and to the recent-log buffer', () => {
    const store = createRecentLogStore({ capacity: 10 });
    const { stream, lines } = createCapturingStream();
    const logger = createLogger({ level: 'info', store, stdout: stream });

    logger.info({ roomId: 'room-1' }, 'message stored');

    expect(lines).toHaveLength(1);
    const [entry] = store.recent();
    expect(entry.msg).toBe('message stored');
    expect(entry.roomId).toBe('room-1');
    expect(entry.level).toBe(30);
    expect(typeof entry.time).toBe('number');
    expect(entry.time).toBeGreaterThan(0);
    // Both destinations saw the same record.
    expect(JSON.parse(lines[0]).msg).toBe(entry.msg);
  });

  it('delivers debug records to both destinations when built at debug', () => {
    // Regression guard: pino.multistream applies its own per-stream level filter
    // that defaults to `info`, so the obvious multistream wiring silently drops
    // every debug record even with the logger at `debug`. The tee destination
    // this module uses leaves the pino instance's level as the only filter.
    const store = createRecentLogStore({ capacity: 10 });
    const { stream, lines } = createCapturingStream();
    const logger = createLogger({ level: 'debug', store, stdout: stream });

    logger.debug('debug reaches both');

    expect(lines).toHaveLength(1);
    expect(messages(store)).toEqual(['debug reaches both']);
  });

  it('stores nothing for records below the configured level', () => {
    const store = createRecentLogStore({ capacity: 10 });
    const { stream, lines } = createCapturingStream();
    const logger = createLogger({ level: 'warn', store, stdout: stream });

    logger.info('filtered out');
    logger.debug('filtered out too');
    logger.warn('kept');

    expect(lines).toHaveLength(1);
    expect(messages(store)).toEqual(['kept']);
  });

  it('redacts credentials before they reach either destination', () => {
    const store = createRecentLogStore({ capacity: 10 });
    const { stream, lines } = createCapturingStream();
    const logger = createLogger({ level: 'info', store, stdout: stream });

    logger.info(
      {
        password: 'hunter2',
        refreshToken: 'refresh-secret',
        req: { headers: { authorization: 'Bearer token-secret' } },
        userId: 'user-1',
      },
      'login attempt',
    );

    const [entry] = store.recent();
    expect(entry.password).toBe('[redacted]');
    expect(entry.refreshToken).toBe('[redacted]');
    expect((entry.req as { headers: { authorization: string } }).headers.authorization).toBe(
      '[redacted]',
    );
    // Non-sensitive context survives.
    expect(entry.userId).toBe('user-1');
    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain('refresh-secret');
    expect(lines[0]).not.toContain('token-secret');
  });

  it('keeps logging a circular payload instead of throwing', () => {
    const store = createRecentLogStore({ capacity: 10 });
    const { stream } = createCapturingStream();
    const logger = createLogger({ level: 'info', store, stdout: stream });

    const circular: Record<string, unknown> = { name: 'circular' };
    circular.self = circular;

    expect(() => logger.info({ circular }, 'circular payload')).not.toThrow();
    expect(messages(store)).toEqual(['circular payload']);
  });

  it('never lets a failing buffer break the caller that logged', () => {
    // pino calls the destination synchronously from inside logger.info(), so a
    // throwing buffer would surface as an application error at the call site.
    const failing: RecentLogStore = {
      capacity: 1,
      size: () => 0,
      recent: () => [],
      push: () => {
        throw new Error('buffer unavailable');
      },
    };
    const { stream, lines } = createCapturingStream();
    const logger = createLogger({ level: 'info', store: failing, stdout: stream });

    expect(() => logger.info('still delivered to stdout')).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});
