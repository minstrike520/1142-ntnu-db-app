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

// Ids reach the repositories as `uuid` comparisons. Anything that is not a UUID
// makes PostgreSQL raise 22P02, which the generic error handler turns into a
// 500 — a malformed request reported as a server fault. These schemas keep that
// on the client's side of the line, as a 400.
export const readPositionSchema = z.object({
  messageId: z.string().uuid('messageId must be a valid UUID'),
});

// The REST create route used to read the body untyped and coerce anything that
// was not the expected type to `undefined`. A client sending `replyToId: 123`
// or a non-array `attachmentIds` then got a 201 for a message that silently
// dropped its reply or attachment intent, where the old Socket.IO path
// rejected the same payload through `sendMessageSchema`. Validating the whole
// body keeps that a 400. Ids are UUIDs for the same reason as the param
// schemas below.
//
// `null` is accepted for the optional fields because that is what the published
// request body in `docs/api-documentation.md` shows; it means the same as
// omitting them.
export const createMessageBodySchema = z.object({
  content: z.string({ message: 'content must be a string' }),
  replyToId: z.string().uuid('replyToId must be a valid UUID').nullish(),
  attachmentIds: z
    .array(z.string().uuid('attachmentIds must contain valid UUIDs'), {
      message: 'attachmentIds must be an array of UUIDs',
    })
    .nullish(),
});

export const roomParamSchema = z.object({
  roomId: z.string().uuid('roomId must be a valid UUID'),
});

export const messageParamSchema = roomParamSchema.extend({
  messageId: z.string().uuid('messageId must be a valid UUID'),
});

export type CreateMessageBody = z.infer<typeof createMessageBodySchema>;
export type SendMessageInput = z.input<typeof sendMessageSchema>;
export type ListMessagesInput = z.input<typeof listMessagesSchema>;
export type RecallMessageInput = z.input<typeof recallMessageSchema>;
