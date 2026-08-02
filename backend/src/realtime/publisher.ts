import type { RealtimeEventType } from '@shared/realtime';
import type { EventPayload } from './frames';

export type PublicationTarget =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'user'; userId: string; excludeConnectionId?: string }
  | { kind: 'room'; roomId: string; excludeConnectionId?: string }
  | { kind: 'broadcast'; excludeConnectionId?: string };

export type RealtimePublication<T extends RealtimeEventType = RealtimeEventType> = {
  target: PublicationTarget;
  type: T;
  streamId: string;
  reliable: boolean;
  payload: EventPayload<T>;
  correlationId?: string;
};

export interface PublishResult {
  delivered: number;
  dropped: number;
}

export interface RealtimePublisher {
  publish<T extends RealtimeEventType>(publication: RealtimePublication<T>): Promise<PublishResult>;
}

export const NOOP_REALTIME_PUBLISHER: RealtimePublisher = {
  async publish() {
    return { delivered: 0, dropped: 0 };
  },
};
