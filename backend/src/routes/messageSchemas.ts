import { z } from 'zod';

const idSchema = z.string().trim().min(1, 'Id cannot be empty');

export const sendMessageSchema = z
  .object({
    roomId: idSchema,
    content: z.string().trim(),
    replyToId: idSchema.optional(),
    attachmentIds: z.array(z.string().uuid()).optional(),
  })
  .refine((data) => data.content.length > 0 || (data.attachmentIds?.length ?? 0) > 0, {
    message: 'Message content cannot be empty',
    path: ['content'],
  });

export const listMessagesSchema = z.object({
  roomId: idSchema,
  beforeId: idSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const listMessagesQuerySchema = listMessagesSchema;

export const recallMessageSchema = z.object({
  roomId: idSchema,
  messageId: idSchema,
});

// The read position targets a message by id, and the repository puts that value
// straight into a `uuid` comparison. Anything that is not a UUID makes
// PostgreSQL raise 22P02, which the generic error handler turns into a 500 —
// a malformed request reported as a server fault. Validated here instead.
export const readPositionSchema = z.object({
  messageId: z.string().uuid('messageId must be a valid UUID'),
});

export type SendMessageInput = z.input<typeof sendMessageSchema>;
export type ListMessagesInput = z.input<typeof listMessagesSchema>;
export type RecallMessageInput = z.input<typeof recallMessageSchema>;
