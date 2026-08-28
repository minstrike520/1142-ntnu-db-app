import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middlewares/authMiddleware';
import { type AdminChecker, makeAdminMiddleware } from '../middlewares/adminMiddleware';
import { validate } from '../middlewares/validator';
import { recentLogs, type RecentLogStore } from '../utils/logger';
import {
  processMetrics,
  requestMetrics,
  type ProcessMetricsSampler,
  type RequestMetricsStore,
} from '../utils/performanceMetrics';
import {
  DEFAULT_SLOW_QUERY_THRESHOLD_MS,
  slowQueries,
  type SlowQueryStore,
} from '../utils/slowQueryStore';

/**
 * The read-only monitoring surface the admin backend (#280) polls.
 *
 * Every buffer these endpoints read was built by an earlier issue in this
 * milestone with this route in mind, so nothing here collects anything: the
 * timing middleware feeds `requestMetrics`, the pino destination feeds
 * `recentLogs`, and the SQL instrumentation feeds `slowQueries`. These handlers
 * only render what those already hold.
 *
 * That is why all three are per-process and reset on restart, and why a
 * multi-instance deployment would report whichever instance the request happened
 * to reach. Each store is an interface for the same reason — swapping in the
 * cross-process, Redis-backed version #283 calls for should not touch this file.
 *
 * Polling, not streaming: #569 scopes the log feed to a plain `GET`, leaving
 * SSE/WebSocket for whenever the panel actually needs sub-poll latency.
 */

/**
 * The data sources, as this module consumes them.
 *
 * A trailing optional parameter defaulting to the real implementations, which is
 * the injection seam this repo uses (`AvatarStore` / `defaultAvatarStore` in
 * `utils/avatarUpload.ts`) — `mock.module()` is process-global within a test
 * tier and cannot be undone, which is what made `avatarUpload.test.ts`
 * order-dependent (issue #467).
 *
 * Narrowed to the read halves on purpose: a monitoring endpoint has no business
 * being able to `record()` a request, `push()` a log line or `reset()` the
 * counters, and stating that in the type means a handler cannot start.
 */
export interface AdminMonitoringSources {
  requestMetrics: Pick<RequestMetricsStore, 'snapshot'>;
  processMetrics: ProcessMetricsSampler;
  logs: Pick<RecentLogStore, 'recent' | 'capacity' | 'size'>;
  slowQueries: Pick<SlowQueryStore, 'recent' | 'capacity' | 'size'>;
}

export const defaultAdminMonitoringSources: AdminMonitoringSources = {
  requestMetrics,
  processMetrics,
  logs: recentLogs,
  slowQueries,
};

/**
 * `?limit=` for a bounded buffer.
 *
 * The buffer's own capacity is both the default and the ceiling: asking for more
 * than it holds is not an error to report, it is simply everything. Built per
 * store rather than as one shared schema because the two buffers are different
 * sizes, and a caller should get a validation error that names the real limit.
 *
 * Blank is treated as absent, matching `syncRoutes`: a UI that always appends
 * `?limit=${value}` sends an empty string before the user has chosen one.
 *
 * Exported for its own unit tests. The handlers stay unexported and reachable
 * only through the gate below — a schema is safe to hand out, an unguarded
 * monitoring sub-app is not.
 */
export const limitQuerySchema = (capacity: number) =>
  z.object({
    limit: z.preprocess(
      (value) => (value === undefined || value === '' ? capacity : Number(value)),
      z.number().int().min(1).max(capacity),
    ),
  });

/**
 * The `/api/v1/admin` namespace, and the only supported way to mount the admin
 * gate.
 *
 * Both middlewares are bound here rather than exported for the composition root
 * to sequence, so a future admin route cannot be added behind a half-applied
 * guard: `httpApp` only ever writes `honoApp.route('/api/v1/admin', ...)`, the
 * same sub-app shape already used for rooms and sync.
 *
 * `checker` is required, not defaulted: the authorization check is a service the
 * composition root owns and hands down, so this module never reaches for a
 * repository or a database handle of its own.
 */
export const makeAdminRoutes = (
  checker: AdminChecker,
  sources: AdminMonitoringSources = defaultAdminMonitoringSources,
) => {
  const app = new Hono();

  app.use('*', authMiddleware);
  app.use('*', makeAdminMiddleware(checker));

  // Monitoring answers must never be served from a cache: a panel polling every
  // few seconds to watch a live incident is the one caller these endpoints have,
  // and a stale 200 from an intermediary would be indistinguishable from a
  // system that had stopped changing.
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  // Kept from before the handlers existed: it proves the guard end to end
  // without depending on any buffer having content, which every endpoint below
  // does. Hono runs matched middleware before falling through to the not-found
  // handler, so an empty sub-app would still enforce 401/403 — but nothing would
  // show that the allowed path returns 200.
  app.get('/health', (c) => c.json({ status: 'ok' }, 200));

  app.get('/metrics', (c) =>
    c.json(
      {
        // Sampled at read time, so `cpu.percent` is the usage since the previous
        // poll rather than a lifetime average. The first call after a restart
        // reports `null` for it — there is no earlier point to difference
        // against, and inventing a zero would read as an idle process.
        process: sources.processMetrics.sample(),
        requests: sources.requestMetrics.snapshot(),
        at: Date.now(),
      },
      200,
    ),
  );

  app.get('/logs', validate('query', limitQuerySchema(sources.logs.capacity)), (c) => {
    const { limit } = c.req.valid('query') as { limit: number };
    return c.json(
      {
        // Oldest first, so a poller can append to what it already rendered.
        entries: sources.logs.recent(limit),
        retained: sources.logs.size(),
        capacity: sources.logs.capacity,
      },
      200,
    );
  });

  app.get(
    '/slow-queries',
    validate('query', limitQuerySchema(sources.slowQueries.capacity)),
    (c) => {
      const { limit } = c.req.valid('query') as { limit: number };
      return c.json(
        {
          queries: sources.slowQueries.recent(limit),
          retained: sources.slowQueries.size(),
          capacity: sources.slowQueries.capacity,
          // Reported rather than left for the panel to hardcode: it is what
          // makes the list meaningful ("slower than this"), and it belongs to
          // the store that applies it, not to the UI.
          thresholdMs: DEFAULT_SLOW_QUERY_THRESHOLD_MS,
        },
        200,
      );
    },
  );

  return app;
};
