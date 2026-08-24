import type { Context, MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../utils/logger';
import { requestMetrics, type RequestMetricsStore } from '../utils/performanceMetrics';
import { AppError } from '../utils/AppError';

export interface RequestTimingOptions {
  logger?: Logger;
  metrics?: RequestMetricsStore;
  /** Monotonic clock in milliseconds. Overridable so tests can assert exact durations. */
  now?: () => number;
  /** Requests this returns `true` for are neither logged nor counted. */
  skip?: (c: Context) => boolean;
}

/**
 * The status the client will actually receive for a request that threw.
 *
 * `errorHandler` only builds the response *after* this middleware unwinds, so
 * `c.res.status` is not yet meaningful on the throwing path. `AppError` already
 * carries the status the handler decided on, and anything else becomes the 500
 * that `mapErrorToApiShape` will produce — keeping the recorded status class in
 * step with what the caller sees.
 */
const statusForError = (error: unknown): number =>
  error instanceof AppError && Number.isFinite(error.statusCode) ? error.statusCode : 500;

/**
 * Time every request and feed the result to the logger and the metrics store.
 *
 * `performance.now()` rather than `Date.now()`: it is monotonic and
 * sub-millisecond, so a clock adjustment mid-request cannot produce a negative
 * duration and a fast handler does not round to a flat `0`.
 *
 * Timing lives in a `finally` so a thrown handler is recorded too — those are
 * the requests whose latency an operator most wants to see, and a middleware
 * that only measures the happy path quietly under-reports exactly when the
 * service is unhealthy. The error itself is re-thrown untouched; reporting it
 * remains `errorHandler`'s job.
 */
export const makeRequestTiming = (options: RequestTimingOptions = {}): MiddlewareHandler => {
  const {
    logger = defaultLogger,
    metrics = requestMetrics,
    now = () => performance.now(),
    skip,
  } = options;

  return async (c, next) => {
    if (skip?.(c)) return next();

    const startedAt = now();
    // `c.req.path` is read up front: the request object is the one thing here
    // guaranteed to be intact on both the success and the throwing path.
    const method = c.req.method;
    const path = c.req.path;
    let status = 500;

    try {
      await next();
      status = c.res.status;
    } catch (error) {
      status = statusForError(error);
      throw error;
    } finally {
      const durationMs = Math.round((now() - startedAt) * 1000) / 1000;
      metrics.record({ method, path, status, durationMs });

      // 5xx is the service's own fault and belongs above the info floor a
      // production deployment usually runs at; 4xx is the caller's and stays at
      // info so a scanner cannot flood the warn stream.
      const level = status >= 500 ? 'warn' : 'info';
      logger[level]({ method, path, status, durationMs }, 'request completed');
    }
  };
};

/** The instance mounted by `bootstrap/httpApp.ts`. */
export const requestTiming: MiddlewareHandler = makeRequestTiming();
