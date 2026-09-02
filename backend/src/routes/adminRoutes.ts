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

/** Read-only monitoring routes polled by the admin panel. */

/** Monitoring data sources consumable by the admin routes. */
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

/** Validation schema for ?limit= query parameter bounded by store capacity. */
export const limitQuerySchema = (capacity: number) =>
  z.object({
    limit: z.preprocess(
      (value) => (value === undefined || value === '' ? capacity : Number(value)),
      z.number().int().min(1).max(capacity),
    ),
  });

/** Mounts admin monitoring routes under /api/v1/admin with auth and admin role checks. */
export const makeAdminRoutes = (
  checker: AdminChecker,
  sources: AdminMonitoringSources = defaultAdminMonitoringSources,
) => {
  const app = new Hono();

  app.use('*', authMiddleware);
  app.use('*', makeAdminMiddleware(checker));

  // Disable caching for live monitoring data.
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.get('/health', (c) => c.json({ status: 'ok' }, 200));

  app.get('/metrics', (c) =>
    c.json(
      {
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
          thresholdMs: DEFAULT_SLOW_QUERY_THRESHOLD_MS,
        },
        200,
      );
    },
  );

  return app;
};
