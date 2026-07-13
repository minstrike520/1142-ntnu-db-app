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

export const recallMessageSchema = z.object({
  roomId: idSchema,
  messageId: idSchema,
});

type SendMessageInput = z.input<typeof sendMessageSchema>;
type ListMessagesInput = z.input<typeof listMessagesSchema>;
type RecallMessageInput = z.input<typeof recallMessageSchema>;
