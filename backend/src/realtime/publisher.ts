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
  addUserToRoom(userId: string, roomId: string): void;
  removeUserFromRoom(userId: string, roomId: string): void;
  disconnectUser(userId: string, reason: string): void;
  shutdown(reason: string): void;
}

export const createRealtimePublisher = (): RealtimePublisher => {
  let io: ChatServer | undefined;

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
      if (!io) return;
      void io.in(`user_${userId}`).socketsJoin(`room_${roomId}`);
    },

    removeUserFromRoom(userId, roomId) {
      if (!io) return;
      void io.in(`user_${userId}`).socketsLeave(`room_${roomId}`);
    },

    disconnectUser(userId, reason) {
      if (!io) return;
      // Socket.IO exposes the close reason to the socket itself, not to the
      // namespace-level disconnectSockets overload. Keep the reason at the
      // domain boundary for logging/call-site clarity while using the
      // transport's supported close operation here.
      void reason;
      io.in(`user_${userId}`).disconnectSockets(true);
    },

    shutdown(reason) {
      if (!io) return;
      void reason;
      io.disconnectSockets(true);
    },
  };
};
