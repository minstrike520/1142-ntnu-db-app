/**
 * A bounded window over the slowest recent database queries.
 *
 * This is the data source the admin `GET /api/v1/admin/slow-queries` endpoint
 * will read from, which is why it is an interface rather than a bare array: the
 * endpoint only needs `recent()`, so the buffer can later be swapped for the
 * Redis-backed, cross-process store that #283 calls for without touching the
 * route. The in-memory implementation here is per-process and resets on restart
 * — a deliberate trade-off, matching the recent-log buffer in `logger.ts`.
 */

/** One query that ran past the slow threshold. */
export interface SlowQueryRecord {
  /**
   * The query's static skeleton with every interpolated value replaced by `?`.
   *
   * Never the bound parameter values: a slow `SELECT ... WHERE email = ${email}`
   * would otherwise park a user's address in a buffer that an HTTP endpoint
   * hands out.
   */
  query: string;
  durationMs: number;
  /** Epoch milliseconds, so a reader can tell a stale record from a live one. */
  at: number;
}

export interface SlowQueryStore {
  push(record: SlowQueryRecord): void;
  /** The newest `limit` records, oldest first. Defaults to everything held. */
  recent(limit?: number): SlowQueryRecord[];
  readonly capacity: number;
  size(): number;
}

/** Matches the "最近 100 筆" the parent issue (#280) asks the admin panel to show. */
export const DEFAULT_SLOW_QUERY_CAPACITY = 100;

export interface CreateSlowQueryStoreOptions {
  capacity?: number;
}

/**
 * A fixed-size ring buffer of slow-query records.
 *
 * A write overwrites the oldest slot rather than appending, so a process whose
 * database has been slow for a week still holds at most `capacity` records and
 * this can never be the reason the backend runs out of memory.
 */
export const createSlowQueryStore = (
  options: CreateSlowQueryStoreOptions = {},
): SlowQueryStore => {
  const { capacity = DEFAULT_SLOW_QUERY_CAPACITY } = options;

  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError(
      `SlowQueryStore capacity must be a positive integer, received ${String(capacity)}`,
    );
  }

  const slots: SlowQueryRecord[] = [];
  // Counts every push ever made, not the number retained. The read path needs it
  // to locate the oldest surviving record after wraparound.
  let written = 0;

  const size = (): number => Math.min(written, capacity);

  return {
    capacity,
    size,

    push(record: SlowQueryRecord): void {
      // Copied rather than stored by reference: the caller keeps no handle on
      // anything the buffer retains for the next `capacity` writes.
      slots[written % capacity] = { ...record };
      written += 1;
    },

    recent(limit: number = capacity): SlowQueryRecord[] {
      const available = size();
      const requested = Number.isFinite(limit) ? Math.max(Math.trunc(limit), 0) : available;
      const wanted = Math.min(requested, available);

      // Walk forward from the oldest retained record, so the caller gets a
      // chronological feed and never a reference to the backing array.
      const records: SlowQueryRecord[] = [];
      for (let cursor = written - wanted; cursor < written; cursor += 1) {
        records.push({ ...slots[cursor % capacity] });
      }
      return records;
    },
  };
};

/** The process-wide buffer the SQL instrumentation feeds and `/slow-queries` reads. */
export const slowQueries: SlowQueryStore = createSlowQueryStore();
