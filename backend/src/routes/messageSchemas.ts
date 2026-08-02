import { z } from 'zod';
import { REALTIME_LIMITS } from '@shared/realtime';

const idSchema = z.string().trim().min(1, 'Id cannot be empty');
const messageTextSchema = z.string().trim().refine(
  (content) => new TextEncoder().encode(content).byteLength <= REALTIME_LIMITS.maxMessageBytes,
  { message: 'Message exceeds the UTF-8 byte limit' },
);

export const sendMessageSchema = z
  .object({
    roomId: idSchema,
    content: messageTextSchema,
    replyToId: idSchema.optional(),
    attachmentIds: z.array(z.string().uuid()).max(REALTIME_LIMITS.maxAttachments).optional(),
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

export type SendMessageInput = z.input<typeof sendMessageSchema>;
export type ListMessagesInput = z.input<typeof listMessagesSchema>;
export type RecallMessageInput = z.input<typeof recallMessageSchema>;
