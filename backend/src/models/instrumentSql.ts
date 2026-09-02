import type { SQL } from 'bun';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../utils/logger';
import {
  DEFAULT_SLOW_QUERY_THRESHOLD_MS,
  slowQueries,
  type SlowQueryStore,
} from '../utils/slowQueryStore';

// Re-exported slow query threshold constant.
export { DEFAULT_SLOW_QUERY_THRESHOLD_MS };

/** Max character length retained for a slow query skeleton in the store. */
export const MAX_QUERY_TEXT_CHARS = 500;

export interface InstrumentSqlOptions {
  logger?: Logger;
  store?: SlowQueryStore;
  thresholdMs?: number;
  /** Monotonic clock in milliseconds. Overridable for testing. */
  now?: () => number;
}

/** Checks whether invocation is a tagged-template literal call (sql\`...\`). */
const isTaggedTemplateCall = (args: unknown[]): args is [TemplateStringsArray, ...unknown[]] => {
  const [first] = args;
  return Array.isArray(first) && Array.isArray((first as { raw?: unknown }).raw);
};

/** Replaces bound parameter placeholders with '?' to create a safe query skeleton. */
export const describeQuery = (strings: readonly string[]): string => {
  const skeleton = strings.join(' ? ').replace(/\s+/g, ' ').trim();
  return skeleton.length > MAX_QUERY_TEXT_CHARS
    ? `${skeleton.slice(0, MAX_QUERY_TEXT_CHARS)}…`
    : skeleton;
};

/** Wraps a Bun.SQL client with proxies to record execution durations of slow queries. */
export const instrumentSql = (sql: SQL, options: InstrumentSqlOptions = {}): SQL => {
  const {
    logger = defaultLogger,
    store = slowQueries,
    thresholdMs = DEFAULT_SLOW_QUERY_THRESHOLD_MS,
    now = () => performance.now(),
  } = options;

  const record = (query: string, durationMs: number): void => {
    if (durationMs <= thresholdMs) return;
    try {
      store.push({ query, durationMs, at: Date.now() });
      logger.warn({ query, durationMs, thresholdMs }, 'slow query');
    } catch {
      // Suppress logging/buffering errors so database operations are never interrupted.
    }
  };

  const instrumentQuery = <T extends object>(query: T, text: string): T => {
    // Scoped to the query, not to one `then` access: a query that is awaited
    // twice performs two property reads, and a flag living inside the trap would
    // be a fresh flag each time — landing a second, near-zero record for a
    // statement that only ran once (Bun resolves the second await from cache).
    let measured = false;

    return new Proxy(query, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);

        if (prop !== 'then' || typeof value !== 'function') {
          // Native methods need the real receiver: handing them the proxy would
          // hide the internal slots they read from.
          return typeof value === 'function' ? value.bind(target) : value;
        }

        return (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => {
          const startedAt = now();
          const settle = (): void => {
            if (measured) return;
            measured = true;
            record(text, now() - startedAt);
          };

          return (value as (...a: unknown[]) => unknown).call(
            target,
            (result: unknown) => {
              settle();
              return onFulfilled ? onFulfilled(result) : result;
            },
            (error: unknown) => {
              // A statement that failed slowly is still a slow statement, and a
              // timeout is exactly the case an operator is looking for.
              settle();
              if (onRejected) return onRejected(error);
              throw error;
            },
          );
        };
      },
    });
  };

  return new Proxy(sql, {
    apply(target, thisArg, args: unknown[]) {
      const query = Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
      if (!isTaggedTemplateCall(args) || typeof query !== 'object' || query === null) {
        return query;
      }
      return instrumentQuery(query, describeQuery(args[0].raw));
    },

    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      // Wrap transaction blocks so statements executed inside them are also timed.
      if (prop === 'begin' || prop === 'transaction') {
        return (...args: unknown[]) =>
          value.apply(
            target,
            args.map((arg) =>
              typeof arg === 'function'
                ? (tx: SQL, ...rest: unknown[]) =>
                    (arg as (...a: unknown[]) => unknown)(instrumentSql(tx, options), ...rest)
                : arg,
            ),
          );
      }

      // Intercept unsafe raw queries to measure dynamic SQL executions.
      if (prop === 'unsafe') {
        return (...args: unknown[]) => {
          const query = value.apply(target, args);
          if (typeof query !== 'object' || query === null) return query;
          const [text] = args;
          return instrumentQuery(
            query,
            typeof text === 'string' ? describeQuery([text]) : 'unsafe statement',
          );
        };
      }

      // Pass all other properties/methods through to the underlying Bun.SQL client.
      return value.bind(target);
    },
  });
};
