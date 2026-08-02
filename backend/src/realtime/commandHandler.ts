import { parseClientFrame, type RealtimeCommand, type RealtimeNackCode } from '@shared/realtime';
import type { MessageDeltaResult, MessageMutationResult } from '../models/realtimeRepository';
import { RealtimeRepositoryError } from '../models/realtimeRepository';
import { AppError } from '../utils/AppError';
import { RealtimeServiceError } from '../services/realtimeService';
import { makeAck, makeNack } from './frames';
import type { RealtimeManager } from './manager';
import type { WsTicketService } from './wsTicket';

interface CommandService {
  sendMessage(
    userId: string,
    connectionId: string,
    commandId: string,
    payload: Extract<RealtimeCommand, { type: 'message.send' }>['payload'],
  ): Promise<MessageMutationResult>;
  editMessage(
    userId: string,
    connectionId: string,
    commandId: string,
    payload: Extract<RealtimeCommand, { type: 'message.edit' }>['payload'],
  ): Promise<MessageMutationResult>;
  recallMessage(
    userId: string,
    connectionId: string,
    commandId: string,
    payload: Extract<RealtimeCommand, { type: 'message.recall' }>['payload'],
  ): Promise<MessageMutationResult>;
  getMessageDelta(
    userId: string,
    payload: Extract<RealtimeCommand, { type: 'message.delta' }>['payload'],
  ): Promise<MessageDeltaResult>;
  advanceReadPosition(
    userId: string,
    connectionId: string,
    roomId: string,
    messageId: string,
  ): Promise<{ messageId: string; advanced: boolean }>;
}

interface RealtimeCommandHandlerOptions {
  manager: RealtimeManager;
  tickets: WsTicketService;
  listAuthorizedRoomIds(userId: string): Promise<string[]>;
  service: CommandService;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

const nackForError = (error: unknown): {
  code: RealtimeNackCode;
  retryable: boolean;
  retryAfterMs?: number;
} => {
  if (error instanceof RealtimeRepositoryError) {
    return {
      code: error.realtimeCode === 'INVALID_OPERATION' ? 'INVALID_PAYLOAD' : error.realtimeCode,
      retryable: false,
    };
  }
  if (error instanceof RealtimeServiceError) {
    return { code: error.realtimeCode, retryable: error.retryable };
  }
  if (error instanceof AppError) {
    const code: RealtimeNackCode = error.statusCode === 403
      ? 'FORBIDDEN'
      : error.statusCode === 404
        ? 'NOT_FOUND'
        : error.statusCode >= 500
          ? 'INTERNAL_ERROR'
          : 'INVALID_PAYLOAD';
    return { code, retryable: error.statusCode >= 500 };
  }
  return { code: 'INTERNAL_ERROR', retryable: true };
};

export class RealtimeCommandHandler {
  private readonly now: () => number;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(private readonly options: RealtimeCommandHandlerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  }

  async handle(connectionId: string, rawFrame: string): Promise<void> {
    const startedAt = this.now();
    const parsed = parseClientFrame(rawFrame);
    if (!parsed.success) {
      const invalidCount = this.options.manager.noteInvalidFrame(connectionId);
      if (parsed.code === 'UNSUPPORTED_VERSION') {
        this.options.manager.close(connectionId, 1002, 'PROTOCOL_MISMATCH');
        return;
      }
      this.options.manager.sendFrame(connectionId, makeNack(
        parsed.correlation ?? { id: 'protocol-error', streamId: 'control' },
        { code: parsed.code, retryable: false },
      ));
      if (invalidCount >= 3) this.options.manager.close(connectionId, 1008, 'INVALID_FRAME_LIMIT');
      return;
    }

    const command = parsed.data;
    const identity = this.options.manager.getIdentity(connectionId);
    if (!identity || identity.leaseExpiresAt <= this.now()) {
      this.options.manager.close(connectionId, 1008, 'AUTH_EXPIRED');
      return;
    }
    const rate = this.options.manager.consumeCommandToken(connectionId);
    if (!rate.allowed) {
      this.options.manager.sendFrame(connectionId, makeNack(command, {
        code: 'RATE_LIMITED',
        retryable: true,
        ...(rate.retryAfterMs === undefined ? {} : { retryAfterMs: rate.retryAfterMs }),
      }));
      return;
    }

    try {
      await this.dispatch(connectionId, identity.userId, command);
      this.log({
        component: 'realtime',
        outcome: 'ack',
        connectionId,
        commandId: command.id,
        streamId: command.streamId,
        type: command.type,
        latencyMs: this.now() - startedAt,
      });
    } catch (error) {
      const nack = nackForError(error);
      this.options.manager.sendFrame(connectionId, makeNack(command, nack));
      this.log({
        component: 'realtime',
        outcome: 'nack',
        connectionId,
        commandId: command.id,
        streamId: command.streamId,
        type: command.type,
        code: nack.code,
        retryable: nack.retryable,
        latencyMs: this.now() - startedAt,
      });
    }
  }

  private async dispatch(connectionId: string, userId: string, command: RealtimeCommand): Promise<void> {
    switch (command.type) {
      case 'auth.renew': {
        const claims = await this.options.tickets.consume(
          command.payload.ticket,
          `${userId}:${command.id}`,
        );
        if (claims.userId !== userId || !this.options.manager.renew(connectionId, userId, claims.leaseExp * 1000)) {
          throw new RealtimeServiceError('FORBIDDEN', false);
        }
        this.ack(connectionId, command, { leaseExpiresAt: new Date(claims.leaseExp * 1000).toISOString() });
        return;
      }
      case 'rooms.sync': {
        const roomIds = await this.options.listAuthorizedRoomIds(userId);
        const synchronized = this.options.manager.syncRooms(connectionId, roomIds);
        if (!synchronized.accepted) {
          throw new RealtimeServiceError('LIMIT_EXCEEDED', false);
        }
        this.ack(connectionId, command, { roomIds: synchronized.roomIds });
        return;
      }
      case 'message.send': {
        const result = await this.options.service.sendMessage(userId, connectionId, command.id, command.payload);
        this.ack(connectionId, command, result);
        return;
      }
      case 'message.edit': {
        const result = await this.options.service.editMessage(userId, connectionId, command.id, command.payload);
        this.ack(connectionId, command, result);
        return;
      }
      case 'message.recall': {
        const result = await this.options.service.recallMessage(userId, connectionId, command.id, command.payload);
        this.ack(connectionId, command, result);
        return;
      }
      case 'message.delta': {
        const result = await this.options.service.getMessageDelta(userId, command.payload);
        this.log({
          component: 'realtime',
          operation: 'message.delta',
          outcome: 'page',
          connectionId,
          commandId: command.id,
          changeCount: result.changes.length,
          complete: result.complete,
          highWaterRevision: result.highWaterRevision,
        });
        await this.options.manager.publish({
          target: { kind: 'connection', connectionId },
          type: 'message.delta',
          streamId: 'control',
          reliable: true,
          correlationId: command.id,
          payload: result,
        });
        this.ack(connectionId, command, {
          cursor: result.cursor,
          highWaterRevision: result.highWaterRevision,
          complete: result.complete,
        });
        return;
      }
      case 'read.advance': {
        const result = await this.options.service.advanceReadPosition(
          userId,
          connectionId,
          command.payload.roomId,
          command.payload.messageId,
        );
        this.ack(connectionId, command, result);
        return;
      }
      case 'typing.set': {
        if (!this.options.manager.hasRoomSubscription(connectionId, command.payload.roomId)) {
          throw new RealtimeServiceError('FORBIDDEN', false);
        }
        const ttlMs = command.payload.ttlMs ?? this.options.manager.limits.typingTtlMs;
        await this.options.manager.publish({
          target: {
            kind: 'room',
            roomId: command.payload.roomId,
            excludeConnectionId: connectionId,
          },
          type: 'typing.changed',
          streamId: `room:${command.payload.roomId}`,
          reliable: false,
          correlationId: command.id,
          payload: {
            roomId: command.payload.roomId,
            userId,
            isTyping: command.payload.isTyping,
            expiresAt: new Date(this.now() + ttlMs).toISOString(),
          },
        });
        this.ack(connectionId, command, { accepted: true, expiresInMs: ttlMs });
      }
    }
  }

  private ack(connectionId: string, command: RealtimeCommand, payload: unknown): void {
    this.options.manager.sendFrame(connectionId, makeAck(command, payload));
  }
}
