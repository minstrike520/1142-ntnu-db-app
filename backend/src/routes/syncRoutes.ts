import { Hono } from 'hono';
import type { MessageChange } from '@shared/types';
import { z } from 'zod';
import { validate } from '../middlewares/validator';

interface SyncService {
  sync(userId: string, cursor: number, limit: number): Promise<MessageChange[]>;
}

const syncQuerySchema = z.object({
  cursor: z.preprocess(
    (value) => (value === undefined || value === '' ? 0 : Number(value)),
    z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  ),
  limit: z.preprocess(
    (value) => (value === undefined || value === '' ? 100 : Number(value)),
    z.number().int().min(1).max(500),
  ),
});

export const makeSyncRoutes = (service: SyncService) => {
  const app = new Hono();

  app.get('/', validate('query', syncQuerySchema), async (c) => {
    const query = c.req.valid('query') as { cursor: number; limit: number };
    const changes = await service.sync(c.get('user').userId, query.cursor, query.limit);
    const nextCursor = changes.at(-1)?.changeSequence ?? query.cursor;
    return c.json({
      changes,
      nextCursor,
      hasMore: changes.length === query.limit,
    }, 200);
  });

  return app;
};
