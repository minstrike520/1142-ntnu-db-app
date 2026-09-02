import type { ServerToClientEvents } from '@shared/types';
import type { ChatServer } from './authSocket';

export type RealtimeEventName = keyof ServerToClientEvents;

/**
 * Transport-independent publication boundary used by services and jobs.
 *
 * The composition root binds the concrete Socket.IO server once it has been
 * assembled. Business code only knows about destinations and typed events.
 *
 * How far a publish reaches is the adapter's business, not this module's. With
 * `REDIS_URL` set, `bootstrap/realtime.ts` installs the cluster adapter in
 * `realtime/redisAdapter.ts` and every destination below — rooms, room
 * membership changes and forced disconnects alike — carries to the other
 * instances. Without it the in-memory adapter stops at the process boundary,
 * and running two instances drops events for anyone connected to a different
 * one: those sockets do not disconnect, so nothing triggers recovery and their
 * state stays stale. That single-instance case is still the documented
 * deployment — one backend container behind Cloudflare Tunnel.
 *
 * One caveat the adapter brings with it: `addUserToRoom` and `removeUserFromRoom`
 * resolve once the change has been published, not once every instance has
 * applied it, and `withRoomSubscriptionLock` below only serialises callers in
 * this process. A room event published immediately after a join can therefore
 * still miss a session held elsewhere, which is the same at-most-once bargain
 * the rest of the fan-out makes and the reason clients reconcile through their
 * Sync Cursor.
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
      // Deliberately cluster-wide: revoking a user's access has to end the
      // sessions they hold on every instance, not only this one.
      io.in(`user_${userId}`).disconnectSockets(true);
    },

    shutdown(reason) {
      if (!io) return;
      console.info('Realtime server shutting down', { reason });
      // `local` is what keeps this process's shutdown from being the whole
      // cluster's. This runs on SIGTERM, and with a cross-instance adapter
      // installed an unqualified `disconnectSockets` publishes the request to
      // every other instance too — so a rolling restart, which stops one
      // container at a time, would drop every client on every node instead of
      // just the ones this process is about to stop serving.
      io.local.disconnectSockets(true);
    },
  };
};
