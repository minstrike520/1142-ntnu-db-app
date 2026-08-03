import { z } from 'zod';

export const REALTIME_SUBPROTOCOL = 'near-chat.v1';
export const PROTOCOL_VERSION = 1 as const;

export const REALTIME_LIMITS = {
  maxFrameBytes: 64 * 1024,
  maxMessageBytes: 16 * 1024,
  maxAttachments: 20,
  maxConnectionsPerUser: 10,
  maxSubscriptionsPerConnection: 1_000,
  maxOutboundBytes: 1024 * 1024,
  maxOutboundFrames: 256,
  commandsPerSecond: 20,
  commandBurst: 40,
  typingTtlMs: 3_000,
  typingThrottleMs: 500,
  presenceGraceMs: 10_000,
  heartbeatIntervalMs: 25_000,
  heartbeatTimeoutMs: 60_000,
  shutdownDrainMs: 5_000,
  deltaPageSize: 100,
  maxCommandRetries: 5,
  maxRecoveryBufferedChanges: 1_000,
  maxTrackedMessageRevisions: 10_000,
} as const;

const idSchema = z.string().trim().min(1).max(128);
const uuidSchema = z.uuid();
const streamIdSchema = z.string().trim().min(1).max(256);
const roomIdSchema = idSchema;
const commandRoomIdSchema = uuidSchema;
const revisionSchema = z.string().regex(/^\d+$/);
const attachmentIdsSchema = z.array(uuidSchema).max(REALTIME_LIMITS.maxAttachments);
const messageTextSchema = z.string().trim().refine(
  (content) => new TextEncoder().encode(content).byteLength <= REALTIME_LIMITS.maxMessageBytes,
  { message: 'Message exceeds the UTF-8 byte limit' },
);
const messageContentSchema = messageTextSchema.refine((content) => content.length > 0, {
  message: 'Message content is required',
});
const messageSendPayloadSchema = z.object({
  roomId: commandRoomIdSchema,
  content: messageTextSchema,
  replyToId: uuidSchema.optional(),
  attachmentIds: attachmentIdsSchema.optional(),
}).strict().refine(
  ({ content, attachmentIds }) => content.length > 0 || Boolean(attachmentIds?.length),
  { message: 'Message content or an attachment is required', path: ['content'] },
);

const commandBaseSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  kind: z.literal('command'),
  id: idSchema,
  streamId: streamIdSchema,
  reliable: z.boolean(),
});

const commandSchemas = {
  'auth.renew': commandBaseSchema.extend({
    type: z.literal('auth.renew'),
    payload: z.object({ ticket: z.string().trim().min(1).max(4096) }).strict(),
  }).strict(),
  'rooms.sync': commandBaseSchema.extend({
    type: z.literal('rooms.sync'),
    payload: z.object({ roomIds: z.array(commandRoomIdSchema).max(1_000).optional() }).strict(),
  }).strict(),
  'message.send': commandBaseSchema.extend({
    type: z.literal('message.send'),
    payload: messageSendPayloadSchema,
  }).strict(),
  'message.edit': commandBaseSchema.extend({
    type: z.literal('message.edit'),
    payload: z.object({
      roomId: commandRoomIdSchema,
      messageId: uuidSchema,
      content: messageContentSchema,
      expectedRevision: revisionSchema,
    }).strict(),
  }).strict(),
  'message.recall': commandBaseSchema.extend({
    type: z.literal('message.recall'),
    payload: z.object({
      roomId: commandRoomIdSchema,
      messageId: uuidSchema,
      expectedRevision: revisionSchema.optional(),
    }).strict(),
  }).strict(),
  'message.delta': commandBaseSchema.extend({
    type: z.literal('message.delta'),
    payload: z.object({
      cursor: z.string().trim().min(1).max(4096).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }).strict(),
  }).strict(),
  'read.advance': commandBaseSchema.extend({
    type: z.literal('read.advance'),
    payload: z.object({ roomId: commandRoomIdSchema, messageId: uuidSchema }).strict(),
  }).strict(),
  'typing.set': commandBaseSchema.extend({
    type: z.literal('typing.set'),
    payload: z.object({
      roomId: commandRoomIdSchema,
      isTyping: z.boolean(),
      ttlMs: z.number().int().min(500).max(10_000).optional(),
    }).strict(),
  }).strict(),
} as const;

export const realtimeCommandSchema = z.discriminatedUnion('type', [
  commandSchemas['auth.renew'],
  commandSchemas['rooms.sync'],
  commandSchemas['message.send'],
  commandSchemas['message.edit'],
  commandSchemas['message.recall'],
  commandSchemas['message.delta'],
  commandSchemas['read.advance'],
  commandSchemas['typing.set'],
]);

export type RealtimeCommand = z.infer<typeof realtimeCommandSchema>;
export type RealtimeCommandType = RealtimeCommand['type'];

export const realtimeMessageSchema = z.object({
  messageId: idSchema,
  roomId: roomIdSchema,
  senderId: idSchema.nullable(),
  content: z.string(),
  replyToId: idSchema.optional(),
  isRecalled: z.boolean(),
  sentAt: z.string().datetime(),
  revision: revisionSchema,
  sender: z.object({
    userId: idSchema,
    name: z.string(),
    avatarUrl: z.string().optional(),
  }).nullable(),
  mentions: z.array(idSchema).optional(),
  attachments: z.array(z.object({
    attachmentId: idSchema,
    uploadedBy: idSchema,
    fileUrl: z.string(),
    fileType: z.string(),
    originalName: z.string(),
    uploadedAt: z.string().datetime(),
  }).strict()).max(REALTIME_LIMITS.maxAttachments).optional(),
}).strict();

export type RealtimeMessage = z.infer<typeof realtimeMessageSchema>;

const eventBaseSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  kind: z.literal('event'),
  id: idSchema,
  correlationId: idSchema.optional(),
  streamId: streamIdSchema,
  reliable: z.boolean(),
});

const messageChangePayloadSchema = z.object({
  revision: revisionSchema,
  message: realtimeMessageSchema,
}).strict();

const eventSchemas = {
  'session.ready': eventBaseSchema.extend({
    type: z.literal('session.ready'),
    payload: z.object({
      userId: idSchema,
      leaseExpiresAt: z.string().datetime(),
      limits: z.object({
        maxFrameBytes: z.number().int().positive(),
        maxMessageBytes: z.number().int().positive(),
        maxAttachments: z.number().int().positive(),
        maxSubscriptionsPerConnection: z.number().int().positive(),
        commandsPerSecond: z.number().int().positive(),
        commandBurst: z.number().int().positive(),
      }).strict(),
    }).strict(),
  }).strict(),
  'auth.expiring': eventBaseSchema.extend({
    type: z.literal('auth.expiring'),
    payload: z.object({ leaseExpiresAt: z.string().datetime() }).strict(),
  }).strict(),
  'rooms.synced': eventBaseSchema.extend({
    type: z.literal('rooms.synced'),
    payload: z.object({ roomIds: z.array(roomIdSchema) }).strict(),
  }).strict(),
  'room.access_revoked': eventBaseSchema.extend({
    type: z.literal('room.access_revoked'),
    payload: z.object({ roomId: roomIdSchema }).strict(),
  }).strict(),
  'message.created': eventBaseSchema.extend({
    type: z.literal('message.created'),
    payload: messageChangePayloadSchema,
  }).strict(),
  'message.updated': eventBaseSchema.extend({
    type: z.literal('message.updated'),
    payload: messageChangePayloadSchema,
  }).strict(),
  'message.recalled': eventBaseSchema.extend({
    type: z.literal('message.recalled'),
    payload: messageChangePayloadSchema,
  }).strict(),
  'message.delta': eventBaseSchema.extend({
    type: z.literal('message.delta'),
    payload: z.object({
      changes: z.array(z.object({
        type: z.enum(['message.created', 'message.updated', 'message.recalled']),
        revision: revisionSchema,
        message: realtimeMessageSchema,
      }).strict()),
      cursor: z.string().nullable(),
      highWaterRevision: revisionSchema,
      complete: z.boolean(),
    }).strict(),
  }).strict(),
  'read.advanced': eventBaseSchema.extend({
    type: z.literal('read.advanced'),
    payload: z.object({ roomId: roomIdSchema, userId: idSchema, messageId: idSchema }).strict(),
  }).strict(),
  'typing.changed': eventBaseSchema.extend({
    type: z.literal('typing.changed'),
    payload: z.object({
      roomId: roomIdSchema,
      userId: idSchema,
      isTyping: z.boolean(),
      expiresAt: z.string().datetime(),
    }).strict(),
  }).strict(),
  'presence.changed': eventBaseSchema.extend({
    type: z.literal('presence.changed'),
    payload: z.object({ userId: idSchema, status: z.enum(['online', 'offline']) }).strict(),
  }).strict(),
  'room.updated': eventBaseSchema.extend({
    type: z.literal('room.updated'),
    payload: z.object({ roomId: roomIdSchema, change: z.string(), data: z.unknown() }).strict(),
  }).strict(),
  'friend.requested': eventBaseSchema.extend({
    type: z.literal('friend.requested'),
    payload: z.object({ data: z.unknown() }).strict(),
  }).strict(),
  'emergency.alert': eventBaseSchema.extend({
    type: z.literal('emergency.alert'),
    payload: z.object({ notificationId: idSchema, userId: idSchema, message: z.string() }).strict(),
  }).strict(),
  'server.draining': eventBaseSchema.extend({
    type: z.literal('server.draining'),
    payload: z.object({ retryAfterMs: z.number().int().nonnegative() }).strict(),
  }).strict(),
} as const;

export const realtimeEventSchema = z.discriminatedUnion('type', [
  eventSchemas['session.ready'],
  eventSchemas['auth.expiring'],
  eventSchemas['rooms.synced'],
  eventSchemas['room.access_revoked'],
  eventSchemas['message.created'],
  eventSchemas['message.updated'],
  eventSchemas['message.recalled'],
  eventSchemas['message.delta'],
  eventSchemas['read.advanced'],
  eventSchemas['typing.changed'],
  eventSchemas['presence.changed'],
  eventSchemas['room.updated'],
  eventSchemas['friend.requested'],
  eventSchemas['emergency.alert'],
  eventSchemas['server.draining'],
]);

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
export type RealtimeEventType = RealtimeEvent['type'];

export const realtimeAckSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  kind: z.literal('ack'),
  id: idSchema,
  correlationId: idSchema,
  streamId: streamIdSchema,
  reliable: z.literal(true),
  type: z.literal('command.ack'),
  payload: z.unknown(),
}).strict();

export const realtimeNackCodeSchema = z.enum([
  'INVALID_JSON',
  'UNSUPPORTED_VERSION',
  'INVALID_ENVELOPE',
  'INVALID_PAYLOAD',
  'UNKNOWN_COMMAND',
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'AUTH_REJECTED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'CURSOR_INVALID',
  'RATE_LIMITED',
  'LIMIT_EXCEEDED',
  'BACKPRESSURE',
  'INTERNAL_ERROR',
  'RETRY_LATER',
]);

export type RealtimeNackCode = z.infer<typeof realtimeNackCodeSchema>;

export const realtimeNackSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  kind: z.literal('nack'),
  id: idSchema,
  correlationId: idSchema,
  streamId: streamIdSchema,
  reliable: z.literal(true),
  type: z.literal('command.nack'),
  payload: z.object({
    code: realtimeNackCodeSchema,
    retryable: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    traceId: idSchema,
  }).strict(),
}).strict();

export type RealtimeAck = z.infer<typeof realtimeAckSchema>;
export type RealtimeNack = z.infer<typeof realtimeNackSchema>;
export type RealtimeServerFrame = RealtimeEvent | RealtimeAck | RealtimeNack;

export type FrameParseErrorCode =
  | 'INVALID_JSON'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_ENVELOPE'
  | 'INVALID_PAYLOAD'
  | 'UNKNOWN_COMMAND';

export type FrameParseResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      code: FrameParseErrorCode;
      correlation?: { id: string; streamId: string };
    };

const parseJson = (text: string): FrameParseResult<unknown> => {
  try {
    return { success: true, data: JSON.parse(text) as unknown };
  } catch {
    return { success: false, code: 'INVALID_JSON' };
  }
};

const hasSupportedVersion = (value: unknown): value is { version: typeof PROTOCOL_VERSION } =>
  typeof value === 'object' && value !== null && 'version' in value && value.version === PROTOCOL_VERSION;

const isObjectWithStringType = (value: unknown): value is { type: string } =>
  typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';

export const parseClientFrame = (text: string): FrameParseResult<RealtimeCommand> => {
  const parsed = parseJson(text);
  if (!parsed.success) return parsed;
  if (!hasSupportedVersion(parsed.data)) return { success: false, code: 'UNSUPPORTED_VERSION' };
  if (!isObjectWithStringType(parsed.data)) return { success: false, code: 'INVALID_ENVELOPE' };

  const envelope = commandBaseSchema.passthrough().safeParse(parsed.data);
  const correlation = envelope.success
    ? { id: envelope.data.id, streamId: envelope.data.streamId }
    : undefined;

  const schema = commandSchemas[parsed.data.type as keyof typeof commandSchemas];
  if (!schema) return {
    success: false,
    code: 'UNKNOWN_COMMAND',
    ...(correlation ? { correlation } : {}),
  };

  const result = schema.safeParse(parsed.data);
  if (!result.success) {
    return {
      success: false,
      code: envelope.success ? 'INVALID_PAYLOAD' : 'INVALID_ENVELOPE',
      ...(correlation ? { correlation } : {}),
    };
  }
  if (result.data.type !== 'typing.set' && !result.data.reliable) {
    return { success: false, code: 'INVALID_PAYLOAD', ...(correlation ? { correlation } : {}) };
  }
  return { success: true, data: result.data as RealtimeCommand };
};

export const parseServerFrame = (text: string): FrameParseResult<RealtimeServerFrame> => {
  const parsed = parseJson(text);
  if (!parsed.success) return parsed;
  if (!hasSupportedVersion(parsed.data)) return { success: false, code: 'UNSUPPORTED_VERSION' };
  if (typeof parsed.data !== 'object' || parsed.data === null || !('kind' in parsed.data)) {
    return { success: false, code: 'INVALID_ENVELOPE' };
  }

  const kind = parsed.data.kind;
  const schema = kind === 'event'
    ? realtimeEventSchema
    : kind === 'ack'
      ? realtimeAckSchema
      : kind === 'nack'
        ? realtimeNackSchema
        : null;
  if (!schema) return { success: false, code: 'INVALID_ENVELOPE' };

  const result = schema.safeParse(parsed.data);
  return result.success
    ? { success: true, data: result.data as RealtimeServerFrame }
    : { success: false, code: 'INVALID_PAYLOAD' };
};

export const serializeServerFrame = (frame: RealtimeServerFrame): string => {
  const result = frame.kind === 'event'
    ? realtimeEventSchema.safeParse(frame)
    : frame.kind === 'ack'
      ? realtimeAckSchema.safeParse(frame)
      : realtimeNackSchema.safeParse(frame);
  if (!result.success) throw new TypeError('Invalid realtime server frame');
  return JSON.stringify(result.data);
};
