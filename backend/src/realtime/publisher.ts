import type { ServerToClientEvents } from '@shared/types';
import type { ChatServer } from './authSocket';

export type RealtimeEventName = keyof ServerToClientEvents;

/**
 * Transport-independent publication boundary used by services and jobs.
 *
 * The composition root binds the concrete Socket.IO server once it has been
 * assembled. Business code only knows about destinations and typed events.
 */
export interface RealtimePublisher {
  bind(io: ChatServer): void;
  publishRoomEvent(roomId: string, event: RealtimeEventName, payload: unknown): void;
  publishUserEvent(userId: string, event: RealtimeEventName, payload: unknown): void;
  addUserToRoom(userId: string, roomId: string): Promise<void>;
  removeUserFromRoom(userId: string, roomId: string): Promise<void>;
  withRoomSubscriptionLock<T>(userId: string, roomId: string, operation: () => Promise<T> | T): Promise<T>;
  disconnectUser(userId: string, reason: string): void;
  shutdown(reason: string): void;
}

export const createRealtimePublisher = (): RealtimePublisher => {
  let io: ChatServer | undefined;
  const subscriptionLocks = new Map<string, Promise<void>>();

  const withRoomSubscriptionLock = async <T>(
    userId: string,
    roomId: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    const key = `${userId}:${roomId}`;
    const prior = subscriptionLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    subscriptionLocks.set(key, current);
    if (prior) await prior;

    try {
      return await operation();
    } finally {
      release();
      if (subscriptionLocks.get(key) === current) subscriptionLocks.delete(key);
    }
  };

  const emit = (target: ReturnType<ChatServer['to']>, event: RealtimeEventName, payload: unknown) => {
    target.emit(event, payload as never);
  };

  return {
    bind(server) {
      io = server;
    },

    publishRoomEvent(roomId, event, payload) {
      if (!io) return;
      emit(io.to(`room_${roomId}`), event, payload);
    },

    publishUserEvent(userId, event, payload) {
      if (!io) return;
      emit(io.to(`user_${userId}`), event, payload);
    },

    addUserToRoom(userId, roomId) {
      return withRoomSubscriptionLock(userId, roomId, async () => {
        if (!io) return;
        await Promise.resolve(io.in(`user_${userId}`).socketsJoin(`room_${roomId}`));
      });
    },

    removeUserFromRoom(userId, roomId) {
      return withRoomSubscriptionLock(userId, roomId, async () => {
        if (!io) return;
        await Promise.resolve(io.in(`user_${userId}`).socketsLeave(`room_${roomId}`));
      });
    },

    withRoomSubscriptionLock,

    disconnectUser(userId, reason) {
      if (!io) return;
      // Keep the reason out of the Socket.IO close API, which only accepts a
      // force flag. It is still useful in a bounded operational log, without
      // logging message contents, tokens, or credentials.
      console.info('Realtime sessions disconnected', { userId, reason });
      io.in(`user_${userId}`).disconnectSockets(true);
    },

    shutdown(reason) {
      if (!io) return;
      console.info('Realtime server shutting down', { reason });
      io.disconnectSockets(true);
    },
  };
};
