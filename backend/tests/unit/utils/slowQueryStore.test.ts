import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_SLOW_QUERY_CAPACITY,
  createSlowQueryStore,
  type SlowQueryStore,
} from '../../../src/utils/slowQueryStore';

/** `n` records, numbered so ordering and eviction are checkable. */
const pushRecords = (store: SlowQueryStore, from: number, to: number): void => {
  for (let n = from; n <= to; n += 1) {
    store.push({ query: `query-${n}`, durationMs: 100 + n, at: 1_700_000_000_000 + n });
  }
};

const texts = (store: SlowQueryStore, limit?: number): string[] =>
  store.recent(limit).map((record) => record.query);

describe('createSlowQueryStore', () => {
  it('rejects a capacity that could not bound anything', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createSlowQueryStore({ capacity })).toThrow(RangeError);
    }
  });

  it('defaults to the capacity the admin panel expects', () => {
    expect(createSlowQueryStore().capacity).toBe(DEFAULT_SLOW_QUERY_CAPACITY);
    expect(DEFAULT_SLOW_QUERY_CAPACITY).toBe(100);
  });

  it('returns nothing when empty', () => {
    const store = createSlowQueryStore({ capacity: 3 });
    expect(store.recent()).toEqual([]);
    expect(store.size()).toBe(0);
  });

  it('keeps every record while below capacity, oldest first', () => {
    const store = createSlowQueryStore({ capacity: 5 });
    pushRecords(store, 1, 3);

    expect(texts(store)).toEqual(['query-1', 'query-2', 'query-3']);
    expect(store.size()).toBe(3);
  });

  it('overwrites the oldest record once full', () => {
    const store = createSlowQueryStore({ capacity: 3 });
    pushRecords(store, 1, 5);

    expect(texts(store)).toEqual(['query-3', 'query-4', 'query-5']);
    expect(store.size()).toBe(3);
  });

  it('returns only the newest records when a limit is given', () => {
    const store = createSlowQueryStore({ capacity: 5 });
    pushRecords(store, 1, 5);

    expect(texts(store, 2)).toEqual(['query-4', 'query-5']);
    expect(texts(store, 0)).toEqual([]);
    expect(texts(store, 99)).toEqual(['query-1', 'query-2', 'query-3', 'query-4', 'query-5']);
  });

  it('carries the duration and timestamp through unchanged', () => {
    const store = createSlowQueryStore({ capacity: 2 });
    store.push({ query: 'SELECT ?', durationMs: 123.5, at: 1_700_000_000_000 });

    expect(store.recent()[0]).toEqual({
      query: 'SELECT ?',
      durationMs: 123.5,
      at: 1_700_000_000_000,
    });
  });

  it('neither retains the callerns object nor hands out the retained one', () => {
    const store = createSlowQueryStore({ capacity: 2 });
    const pushed = { query: 'SELECT ?', durationMs: 150, at: 1 };
    store.push(pushed);

    // Mutating what was pushed must not rewrite history...
    pushed.query = 'mutated after push';
    expect(store.recent()[0].query).toBe('SELECT ?');

    // ...and mutating what was read must not corrupt the buffer.
    const read = store.recent()[0];
    read.query = 'mutated after read';
    expect(store.recent()[0].query).toBe('SELECT ?');
  });
});
