import type { MessageWithSender } from '@shared/types';
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../middlewares/validator';
import {
  createMessageBodySchema,
  messageParamSchema,
  readPositionSchema,
  roomParamSchema,
  type CreateMessageBody,
} from './messageSchemas';
import { ValidationError } from '../utils/AppError';

export interface MessageService {
  sendMessage?(
    userId: string,
    roomId: string,
    content: string,
    opts?: { replyToId?: string; attachmentIds?: string[]; commandId?: string }
  ): Promise<MessageWithSender>;
  listForRoom(
    userId: string,
    roomId: string,
    opts?: { beforeId?: string; limit?: number }
  ): Promise<MessageWithSender[]>;
  updateMessage?(
    userId: string,
    roomId: string,
    messageId: string,
    content: string,
    opts?: { expectedRevision?: number; commandId?: string }
  ): Promise<MessageWithSender>;
  recallMessage?(
    userId: string,
    roomId: string,
    messageId: string,
    opts?: { expectedRevision?: number; commandId?: string }
  ): Promise<MessageWithSender>;
  markRead?(
    userId: string,
    roomId: string,
    messageId: string,
    commandId?: string
  ): Promise<unknown>;
}

const requiredCommandId = (c: { req: { header(name: string): string | undefined } }): string => {
  const commandId = c.req.header('Idempotency-Key')?.trim();
  if (!commandId) throw new ValidationError('Idempotency-Key header is required');
  if (commandId.length > 255) throw new ValidationError('Idempotency-Key is too long');
  return commandId;
};

const parseRevision = (value: string | undefined): number => {
  if (!value) throw new ValidationError('If-Match header is required');
  const match = value.match(/^(?:W\/)?"?(\d+)"?$/);
  const revision = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ValidationError('If-Match must contain a positive message revision');
  }
  return revision;
};

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

  app.get('/:roomId/messages', validate('param', roomParamSchema), validate('query', listMessagesQuerySchema), async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('roomId');
    const query = c.req.valid('query') as { before_id?: string; beforeId?: string; limit?: number };
    const beforeId = query.before_id ?? query.beforeId;
    const limit = query.limit ?? 50;

    const messages = await service.listForRoom(userId, roomId, { beforeId, limit });
    return c.json(messages, 200);
  });

  app.post(
    '/:roomId/messages',
    validate('param', roomParamSchema),
    validate('json', createMessageBodySchema),
    async (c) => {
      if (!service.sendMessage) return c.body(null, 404);
      const userId = c.get('user').userId;
      const roomId = c.req.param('roomId');
      // Cast for the same reason as the query validator above: `validate` takes
      // a bare ZodSchema, so Hono cannot infer the parsed shape. The schema is
      // what guarantees it.
      const body = c.req.valid('json') as CreateMessageBody;
      const commandId = requiredCommandId(c);
      const message = await service.sendMessage(userId, roomId, body.content, {
        replyToId: body.replyToId ?? undefined,
        attachmentIds: body.attachmentIds ?? undefined,
        commandId,
      });
      return c.json(message, 201);
    },
  );

  app.patch('/:roomId/messages/:messageId', validate('param', messageParamSchema), async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('roomId');
    const messageId = c.req.param('messageId');
    const body = await c.req.json().catch(() => ({}));

    if (typeof body.content !== 'string') {
      throw new ValidationError('content must be a string');
    }

    if (service.updateMessage) {
      const updated = await service.updateMessage(userId, roomId, messageId, body.content, {
        expectedRevision: parseRevision(c.req.header('If-Match')),
        commandId: requiredCommandId(c),
      });
      return c.json(updated, 200);
    }
    return c.body(null, 204);
  });

  app.post('/:roomId/messages/:messageId/recall', validate('param', messageParamSchema), async (c) => {
    if (!service.recallMessage) return c.body(null, 404);
    const userId = c.get('user').userId;
    const recalled = await service.recallMessage(userId, c.req.param('roomId'), c.req.param('messageId'), {
      expectedRevision: parseRevision(c.req.header('If-Match')),
      commandId: requiredCommandId(c),
    });
    return c.json(recalled, 200);
  });

  app.put('/:roomId/read-position', validate('param', roomParamSchema), validate('json', readPositionSchema), async (c) => {
    if (!service.markRead) return c.body(null, 404);
    // Cast for the same reason as the query validator above: `validate` takes a
    // bare ZodSchema, so Hono cannot infer the parsed shape. The schema is what
    // guarantees it.
    const { messageId } = c.req.valid('json') as { messageId: string };
    const member = await service.markRead(
      c.get('user').userId,
      c.req.param('roomId'),
      messageId,
      requiredCommandId(c),
    );
    return c.json(member, 200);
  });

  return app;
};
