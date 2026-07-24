import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../middlewares/validator';
import { authMiddleware } from '../middlewares/authMiddleware';
import { ValidationError } from '../utils/AppError';

export interface MessageService {
  listForRoom(
    userId: string,
    roomId: string,
    opts?: { beforeId?: string; limit?: number }
  ): Promise<any>;
  updateMessage?(
    userId: string,
    roomId: string,
    messageId: string,
    content: string
  ): Promise<any>;
}

export const listMessagesQuerySchema = z.object({
  before_id: z.string().optional(),
  beforeId: z.string().optional(),
  limit: z.preprocess(
    (val) => (val === undefined || val === '' ? 50 : Number(val)),
    z.number({ message: 'limit must be an integer between 1 and 100' })
      .int('limit must be an integer between 1 and 100')
      .min(1, 'limit must be an integer between 1 and 100')
      .max(100, 'limit must be an integer between 1 and 100')
  ),
});

export const makeMessageRoutes = (service: MessageService) => {
  const app = new Hono();

  app.use('*', authMiddleware);

  app.get('/:roomId/messages', validate('query', listMessagesQuerySchema), async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('roomId');
    const query = c.req.valid('query') as any;
    const beforeId = query.before_id ?? query.beforeId;
    const limit = query.limit ?? 50;

    const messages = await service.listForRoom(userId, roomId, { beforeId, limit });
    return c.json(messages, 200);
  });

  app.patch('/:roomId/messages/:messageId', async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('roomId');
    const messageId = c.req.param('messageId');
    const body = await c.req.json().catch(() => ({}));

    if (typeof body.content !== 'string') {
      throw new ValidationError('content must be a string');
    }

    if (service.updateMessage) {
      const updated = await service.updateMessage(userId, roomId, messageId, body.content);
      return c.json(updated, 200);
    }
    return c.body(null, 204);
  });

  return app;
};
