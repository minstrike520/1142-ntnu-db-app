import type { SQL } from 'bun';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../utils/logger';
import { slowQueries, type SlowQueryStore } from '../utils/slowQueryStore';

/**
 * The threshold #280 names: anything slower is worth an operator's attention.
 */
export const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 100;

/**
 * Ceiling on a retained query skeleton, in characters.
 *
 * The record count alone does not bound memory — one enormous generated
 * statement would sit in the ring until 100 more push it out — and the text is
 * only ever read by a human scanning for the shape of a slow query, which the
 * first few hundred characters already give.
 */
export const MAX_QUERY_TEXT_CHARS = 500;

export interface InstrumentSqlOptions {
  logger?: Logger;
  store?: SlowQueryStore;
  thresholdMs?: number;
  /** Monotonic clock in milliseconds. Overridable so tests can assert exact durations. */
  now?: () => number;
}

/**
 * A tagged-template call, as opposed to one of Bun.SQL's helper calls.
 *
 * This matters because `` sql`SELECT 1` `` and `sql('users')` both return a
 * `Query` object, so the return value cannot tell them apart. The first is a
 * statement to time; the second builds an identifier/values fragment that gets
 * interpolated into another query and never executes on its own. Timing a
 * fragment would report a duration for something that never ran, so the
 * distinction is drawn where it is unambiguous: only a tagged template receives
 * a strings array carrying `raw`.
 */
const isTaggedTemplateCall = (args: unknown[]): args is [TemplateStringsArray, ...unknown[]] => {
  const [first] = args;
  return Array.isArray(first) && Array.isArray((first as { raw?: unknown }).raw);
};

/**
 * The query's shape with every interpolated value replaced by `?`.
 *
 * Built from the template's static strings, which is what makes this safe by
 * construction rather than by filtering: the bound values are in the *other*
 * half of the tagged-template arguments and are never touched here, so no
 * password, token or email address can reach the buffer this text lands in.
 */
export const describeQuery = (strings: readonly string[]): string => {
  const skeleton = strings.join(' ? ').replace(/\s+/g, ' ').trim();
  return skeleton.length > MAX_QUERY_TEXT_CHARS
    ? `${skeleton.slice(0, MAX_QUERY_TEXT_CHARS)}…`
    : skeleton;
};

/**
 * Wrap a Bun.SQL client so every statement it runs is timed.
 *
 * ## Why a proxy over the callable, and not per-repository timing
 *
 * The two candidate interception points were the repositories (add timing to
 * each of the eight `*Repository` classes) and the client itself. The client
 * wins on coverage that does not decay: a repository added next month is timed
 * without anyone remembering to instrument it, and the ~200 call sites stay
 * untouched. `Bun.SQL` is a callable object, so an `apply` trap sees every
 * `` sql`...` `` invocation from one place.
 *
 * ## Why timing starts on `then`, not when the template is invoked
 *
 * A `Query` is lazy: `` sql`SELECT 1` `` builds it, and execution begins only
 * when it is awaited (verified against a live PostgreSQL — `query.active` stays
 * false until then). Starting the clock in the `apply` trap would therefore
 * charge a query for however long the caller sat on it before awaiting. The
 * clock starts in the `then` trap instead, which is the moment execution
 * actually begins.
 *
 * `then` is also the *only* method intercepted, deliberately. Every call site in
 * this codebase plain-awaits its query, so `then` covers all real traffic, and
 * anything else — `.execute()`, `.values()`, `.raw()`, `.cancel()` — falls
 * through to Bun untouched. The failure mode of that choice is a query that goes
 * unmeasured, never a query that breaks.
 */
export const instrumentSql = (sql: SQL, options: InstrumentSqlOptions = {}): SQL => {
  const {
    logger = defaultLogger,
    store = slowQueries,
    thresholdMs = DEFAULT_SLOW_QUERY_THRESHOLD_MS,
    now = () => performance.now(),
  } = options;

  const record = (query: string, durationMs: number): void => {
    if (durationMs <= thresholdMs) return;
    // This runs inside the caller's `await`; a throw here would turn a
    // successful query into a failed request, so monitoring must never be able
    // to fail the thing it monitors.
    try {
      // Buffered before it is logged: the buffer is what the admin panel reads,
      // so if only one of the two can happen it should be that one.
      store.push({ query, durationMs, at: Date.now() });
      logger.warn({ query, durationMs, thresholdMs }, 'slow query');
    } catch {
      // Losing one slow-query record is strictly better than losing the query.
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

      // Statements inside a transaction run on the handle `begin` hands the
      // callback, not on this client, so without this they would be the one part
      // of the data layer that goes unmeasured — and transactions are where the
      // multi-statement, lock-holding work lives. The handle is itself callable,
      // so the same wrapper applies to it.
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

      // `unsafe` is a real query path, not an escape hatch nobody uses:
      // `UserRepository.update()` builds its SET list dynamically and runs the
      // profile/settings write through it, so leaving it out would silently
      // exclude a user-facing write from the monitoring. (Migrations do not come
      // through here at all — `migrate.ts` constructs its own unwrapped client.)
      //
      // Recording its text is as safe as the tagged-template path for the same
      // structural reason: `unsafe(text, values)` keeps the bound values in a
      // separate argument this code never reads, and every call site in this
      // repository passes `$n` placeholders rather than interpolated literals.
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

      // Everything else — `close`, `reserve`, `file` — passes straight through.
      return value.bind(target);
    },
  });
};
