import { createHash } from 'node:crypto';
import type { RealtimeCommand, RealtimeMessage, RealtimeNackCode } from '@shared/realtime';
import type { RoomMemberRole } from '@shared/types';
import type { MessageDeltaResult, MessageMutationResult } from '../models/realtimeRepository';
import type { RealtimePublisher } from '../realtime/publisher';
import { AppError } from '../utils/AppError';

type CommandPayload<T extends RealtimeCommand['type']> = Extract<RealtimeCommand, { type: T }>['payload'];

interface RealtimeDataRepository {
  hasAuthorizedMembership(userId: string, roomId: string): Promise<boolean>;
  getRoomAccess(userId: string, roomId: string): Promise<{
    role: RoomMemberRole;
    isMuted: boolean;
    isArchived: boolean;
    isReadonly: boolean;
  } | null>;
  resolveMentionUserIds(
    roomId: string,
    names: string[],
    includeEveryone: boolean,
    excludeUserId: string,
  ): Promise<string[]>;
  createMessage(input: {
    userId: string;
    commandId: string;
    payloadHash: string;
    roomId: string;
    content: string;
    replyToId?: string;
    attachmentIds?: string[];
    mentionIds?: string[];
  }): Promise<MessageMutationResult>;
  editMessage(input: {
    userId: string;
    roomId: string;
    commandId: string;
    payloadHash: string;
    messageId: string;
    expectedRevision: string;
    content: string;
    mentionIds?: string[];
  }): Promise<MessageMutationResult>;
  recallMessage(input: {
    userId: string;
    roomId: string;
    commandId: string;
    payloadHash: string;
    messageId: string;
    expectedRevision?: string;
    actorRole: RoomMemberRole;
  }): Promise<MessageMutationResult>;
  getMessageDelta(userId: string, options?: { cursor?: string; limit?: number }): Promise<MessageDeltaResult>;
  advanceReadPosition(userId: string, roomId: string, messageId: string): Promise<{
    messageId: string;
    advanced: boolean;
  }>;
  createEmergencyNotification(input: {
    sourceUserId: string;
    recipientId: string;
    idempotencyKey: string;
    message: string;
  }): Promise<{ notificationId: string; replayed: boolean; published: boolean }>;
  markEmergencyNotificationPublished(notificationId: string): Promise<void>;
  listEmergencyNotifications(recipientId: string): Promise<Array<{
    notificationId: string;
    userId: string;
    message: string;
    createdAt: string;
  }>>;
}

export class RealtimeServiceError extends AppError {
  readonly realtimeCode: RealtimeNackCode;

  constructor(
    code: RealtimeNackCode,
    readonly retryable: boolean,
  ) {
    const statusCode = code === 'FORBIDDEN'
      ? 403
      : code === 'NOT_FOUND'
        ? 404
        : code === 'VERSION_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT'
          ? 409
          : retryable
            ? 503
            : 400;
    super(statusCode, code, code);
    this.name = 'RealtimeServiceError';
    this.realtimeCode = code;
  }
}

const hashMessageIntent = (payload: CommandPayload<'message.send'>): string =>
  createHash('sha256').update(JSON.stringify({
    roomId: payload.roomId,
    content: payload.content,
    replyToId: payload.replyToId ?? null,
    attachmentIds: payload.attachmentIds ?? [],
  })).digest('hex');

const hashCommandIntent = (type: string, payload: unknown): string =>
  createHash('sha256').update(JSON.stringify({ type, payload })).digest('hex');

const parseMentions = (content: string): { names: string[]; everyone: boolean } => {
  const values = Array.from(new Set(
    [...content.matchAll(/@([^\s@]+)/g)]
      .map((match) => match[1].replace(/[.,!?;:]+$/, ''))
      .filter(Boolean),
  ));
  return {
    names: values.filter((name) => name.toLowerCase() !== 'everyone'),
    everyone: values.some((name) => name.toLowerCase() === 'everyone'),
  };
};

const ensureReliablePublication = (result: { dropped: number }): void => {
  if (result.dropped > 0) throw new RealtimeServiceError('BACKPRESSURE', true);
};

export const makeRealtimeService = (dependencies: {
  repository: RealtimeDataRepository;
  publisher: RealtimePublisher;
}) => {
  const { repository, publisher } = dependencies;

  const requireRoomAccess = async (userId: string, roomId: string) => {
    const access = await repository.getRoomAccess(userId, roomId);
    if (!access) throw new RealtimeServiceError('FORBIDDEN', false);
    return access;
  };

  const requireWritableRoom = async (userId: string, roomId: string) => {
    const access = await requireRoomAccess(userId, roomId);
    if (access.isArchived || access.isReadonly || access.isMuted) {
      throw new RealtimeServiceError('FORBIDDEN', false);
    }
    return access;
  };

  const resolveMentions = async (userId: string, roomId: string, content: string) => {
    const mentions = parseMentions(content);
    if (mentions.names.length === 0 && !mentions.everyone) return [];
    return repository.resolveMentionUserIds(
      roomId,
      mentions.names,
      mentions.everyone,
      userId,
    );
  };

  const publishMessage = async (
    type: 'message.created' | 'message.updated' | 'message.recalled',
    message: RealtimeMessage,
    connectionId: string,
    correlationId: string,
  ): Promise<void> => {
    const result = await publisher.publish({
      target: { kind: 'room', roomId: message.roomId, excludeConnectionId: connectionId },
      type,
      streamId: `room:${message.roomId}`,
      reliable: true,
      correlationId,
      payload: { revision: message.revision, message },
    });
    ensureReliablePublication(result);
  };

  return {
    async sendMessage(
      userId: string,
      connectionId: string,
      commandId: string,
      payload: CommandPayload<'message.send'>,
    ): Promise<MessageMutationResult> {
      await requireWritableRoom(userId, payload.roomId);
      const mentionIds = await resolveMentions(userId, payload.roomId, payload.content);
      const result = await repository.createMessage({
        userId,
        commandId,
        payloadHash: hashMessageIntent(payload),
        roomId: payload.roomId,
        content: payload.content,
        ...(payload.replyToId ? { replyToId: payload.replyToId } : {}),
        ...(payload.attachmentIds ? { attachmentIds: payload.attachmentIds } : {}),
        ...(mentionIds.length > 0 ? { mentionIds } : {}),
      });
      await publishMessage('message.created', result.message, connectionId, commandId);
      const readPublication = await publisher.publish({
        target: { kind: 'room', roomId: payload.roomId, excludeConnectionId: connectionId },
        type: 'read.advanced',
        streamId: `room:${payload.roomId}`,
        reliable: true,
        correlationId: commandId,
        payload: { roomId: payload.roomId, userId, messageId: result.message.messageId },
      });
      ensureReliablePublication(readPublication);
      return result;
    },

    async editMessage(
      userId: string,
      connectionId: string,
      commandId: string,
      payload: CommandPayload<'message.edit'>,
    ): Promise<MessageMutationResult> {
      await requireWritableRoom(userId, payload.roomId);
      const mentionIds = await resolveMentions(userId, payload.roomId, payload.content);
      const result = await repository.editMessage({
        userId,
        roomId: payload.roomId,
        commandId,
        payloadHash: hashCommandIntent('message.edit', payload),
        messageId: payload.messageId,
        expectedRevision: payload.expectedRevision,
        content: payload.content,
        ...(mentionIds.length > 0 ? { mentionIds } : {}),
      });
      await publishMessage('message.updated', result.message, connectionId, commandId);
      return result;
    },

    async recallMessage(
      userId: string,
      connectionId: string,
      commandId: string,
      payload: CommandPayload<'message.recall'>,
    ): Promise<MessageMutationResult> {
      const access = await requireRoomAccess(userId, payload.roomId);
      const result = await repository.recallMessage({
        userId,
        roomId: payload.roomId,
        commandId,
        payloadHash: hashCommandIntent('message.recall', payload),
        messageId: payload.messageId,
        ...(payload.expectedRevision ? { expectedRevision: payload.expectedRevision } : {}),
        actorRole: access.role,
      });
      await publishMessage('message.recalled', result.message, connectionId, commandId);
      return result;
    },

    getMessageDelta(
      userId: string,
      payload: CommandPayload<'message.delta'>,
    ): Promise<MessageDeltaResult> {
      return repository.getMessageDelta(userId, payload);
    },

    async advanceReadPosition(
      userId: string,
      connectionId: string,
      roomId: string,
      messageId: string,
    ): Promise<{ messageId: string; advanced: boolean }> {
      const result = await repository.advanceReadPosition(userId, roomId, messageId);
      if (result.advanced) {
        await publisher.publish({
          target: { kind: 'room', roomId, excludeConnectionId: connectionId },
          type: 'read.advanced',
          streamId: `room:${roomId}`,
          reliable: true,
          payload: { roomId, userId, messageId: result.messageId },
        });
      }
      return result;
    },

    async deliverEmergencyAlert(input: {
      sourceUserId: string;
      recipientId: string;
      idempotencyKey: string;
      message: string;
    }): Promise<{ notificationId: string; replayed: boolean }> {
      const durable = await repository.createEmergencyNotification(input);
      if (!durable.published) {
        const result = await publisher.publish({
          target: { kind: 'user', userId: input.recipientId },
          type: 'emergency.alert',
          streamId: `user:${input.recipientId}`,
          reliable: true,
          payload: {
            notificationId: durable.notificationId,
            userId: input.sourceUserId,
            message: input.message,
          },
        });
        ensureReliablePublication(result);
        await repository.markEmergencyNotificationPublished(durable.notificationId);
      }
      return durable;
    },

    listEmergencyNotifications(recipientId: string) {
      return repository.listEmergencyNotifications(recipientId);
    },
  };
};

export type RealtimeService = ReturnType<typeof makeRealtimeService>;
