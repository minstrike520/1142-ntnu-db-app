import { randomUUID } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  type RealtimeAck,
  type RealtimeCommand,
  type RealtimeEvent,
  type RealtimeEventType,
  type RealtimeNack,
  type RealtimeNackCode,
} from '@shared/realtime';

export type EventPayload<T extends RealtimeEventType> = Extract<RealtimeEvent, { type: T }>['payload'];

export const makeEvent = <T extends RealtimeEventType>(input: {
  type: T;
  streamId: string;
  reliable: boolean;
  payload: EventPayload<T>;
  correlationId?: string;
}): Extract<RealtimeEvent, { type: T }> => ({
  version: PROTOCOL_VERSION,
  kind: 'event',
  id: randomUUID(),
  type: input.type,
  streamId: input.streamId,
  reliable: input.reliable,
  payload: input.payload,
  ...(input.correlationId ? { correlationId: input.correlationId } : {}),
} as Extract<RealtimeEvent, { type: T }>);

export const makeAck = (command: RealtimeCommand, payload: unknown): RealtimeAck => ({
  version: PROTOCOL_VERSION,
  kind: 'ack',
  id: randomUUID(),
  correlationId: command.id,
  streamId: command.streamId,
  reliable: true,
  type: 'command.ack',
  payload,
});

export const makeNack = (
  correlation: Pick<RealtimeCommand, 'id' | 'streamId'>,
  input: {
    code: RealtimeNackCode;
    retryable: boolean;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
    traceId?: string;
  },
): RealtimeNack => ({
  version: PROTOCOL_VERSION,
  kind: 'nack',
  id: randomUUID(),
  correlationId: correlation.id,
  streamId: correlation.streamId,
  reliable: true,
  type: 'command.nack',
  payload: {
    code: input.code,
    retryable: input.retryable,
    traceId: input.traceId ?? randomUUID(),
    ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
    ...(input.details === undefined ? {} : { details: input.details }),
  },
});
