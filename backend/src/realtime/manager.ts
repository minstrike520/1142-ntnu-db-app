import {
  REALTIME_LIMITS,
  serializeServerFrame,
  type RealtimeEventType,
  type RealtimeServerFrame,
} from '@shared/realtime';
import { makeEvent, type EventPayload } from './frames';
import type { PublishResult, RealtimePublication, RealtimePublisher } from './publisher';

export interface RealtimeConnection {
  readonly bufferedAmount: number;
  send(frame: string): number;
  close(code: number, reason: string): void;
  ping(): void;
}

interface ConnectionMetadata {
  connectionId: string;
  userId: string;
  leaseExpiresAt: number;
  roomIds: Set<string>;
  lastPongAt: number;
  commandTokens: number;
  commandTokenUpdatedAt: number;
  invalidFrames: number;
  authExpiringSent: boolean;
  outboundFrames: number;
}

export interface ConnectionRegistration {
  connectionId: string;
  userId: string;
  leaseExpiresAt: number;
}

interface RealtimeManagerOptions {
  now?: () => number;
  presenceRecipients?: (userId: string) => Promise<string[]>;
  schedule?: (callback: () => void | Promise<void>, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  limits?: Partial<RealtimeLimits>;
  log?: (entry: Record<string, unknown>) => void;
}

type RealtimeLimits = { [K in keyof typeof REALTIME_LIMITS]: number };

export class RealtimeManager implements RealtimePublisher {
  private readonly connections = new Map<string, RealtimeConnection>();
  private readonly metadata = new Map<string, ConnectionMetadata>();
  private readonly userConnections = new Map<string, Set<string>>();
  private readonly roomConnections = new Map<string, Set<string>>();
  private readonly offlineTimers = new Map<string, unknown>();
  private readonly now: () => number;
  private readonly presenceRecipients: (userId: string) => Promise<string[]>;
  private readonly schedule: (callback: () => void | Promise<void>, delayMs: number) => unknown;
  private readonly cancelSchedule: (handle: unknown) => void;
  readonly limits: RealtimeLimits;
  private draining = false;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(options: RealtimeManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.presenceRecipients = options.presenceRecipients ?? (async () => []);
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(() => void callback(), delayMs));
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.limits = { ...REALTIME_LIMITS, ...options.limits };
    this.log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  }

  async register(connection: RealtimeConnection, registration: ConnectionRegistration): Promise<boolean> {
    if (this.draining || registration.leaseExpiresAt <= this.now()) {
      this.log({
        component: 'realtime',
        operation: 'connection.register',
        outcome: 'rejected',
        reason: this.draining ? 'SERVER_DRAINING' : 'AUTH_EXPIRED',
        userId: registration.userId,
      });
      connection.close(1008, this.draining ? 'SERVER_DRAINING' : 'AUTH_EXPIRED');
      return false;
    }

    const userSet = this.userConnections.get(registration.userId) ?? new Set<string>();
    if (userSet.size >= this.limits.maxConnectionsPerUser) {
      this.log({
        component: 'realtime',
        operation: 'connection.register',
        outcome: 'rejected',
        reason: 'CONNECTION_LIMIT',
        userId: registration.userId,
      });
      connection.close(1008, 'CONNECTION_LIMIT');
      return false;
    }

    const wasOffline = userSet.size === 0;
    const pendingOffline = this.offlineTimers.get(registration.userId);
    if (pendingOffline !== undefined) {
      this.cancelSchedule(pendingOffline);
      this.offlineTimers.delete(registration.userId);
    }

    this.connections.set(registration.connectionId, connection);
    this.metadata.set(registration.connectionId, {
      ...registration,
      roomIds: new Set(),
      lastPongAt: this.now(),
      commandTokens: this.limits.commandBurst,
      commandTokenUpdatedAt: this.now(),
      invalidFrames: 0,
      authExpiringSent: false,
      outboundFrames: 0,
    });
    userSet.add(registration.connectionId);
    this.userConnections.set(registration.userId, userSet);
    this.log({
      component: 'realtime',
      operation: 'connection.register',
      outcome: 'accepted',
      connectionId: registration.connectionId,
      userId: registration.userId,
      activeConnections: this.connections.size,
      userConnections: userSet.size,
    });

    this.sendEvent(registration.connectionId, {
      type: 'session.ready',
      streamId: 'control',
      reliable: true,
      payload: {
        userId: registration.userId,
        leaseExpiresAt: new Date(registration.leaseExpiresAt).toISOString(),
        limits: {
          maxFrameBytes: this.limits.maxFrameBytes,
          maxMessageBytes: this.limits.maxMessageBytes,
          maxAttachments: this.limits.maxAttachments,
          maxSubscriptionsPerConnection: this.limits.maxSubscriptionsPerConnection,
          commandsPerSecond: this.limits.commandsPerSecond,
          commandBurst: this.limits.commandBurst,
        },
      },
    });

    if (wasOffline) await this.publishPresence(registration.userId, 'online');
    return true;
  }

  async remove(connectionId: string): Promise<void> {
    const meta = this.metadata.get(connectionId);
    if (!meta) return;

    this.connections.delete(connectionId);
    this.metadata.delete(connectionId);
    for (const roomId of meta.roomIds) this.removeIndex(this.roomConnections, roomId, connectionId);
    this.removeIndex(this.userConnections, meta.userId, connectionId);
    this.log({
      component: 'realtime',
      operation: 'connection.remove',
      outcome: 'complete',
      connectionId,
      userId: meta.userId,
      activeConnections: this.connections.size,
    });

    if ((this.userConnections.get(meta.userId)?.size ?? 0) === 0 && !this.offlineTimers.has(meta.userId)) {
      const handle = this.schedule(async () => {
        this.offlineTimers.delete(meta.userId);
        if ((this.userConnections.get(meta.userId)?.size ?? 0) === 0) {
          await this.publishPresence(meta.userId, 'offline');
        }
      }, this.limits.presenceGraceMs);
      this.offlineTimers.set(meta.userId, handle);
    }
  }

  syncRooms(connectionId: string, authorizedRoomIds: readonly string[]): {
    accepted: boolean;
    roomIds: string[];
  } {
    const meta = this.metadata.get(connectionId);
    if (!meta) return { accepted: false, roomIds: [] };
    if (authorizedRoomIds.length > this.limits.maxSubscriptionsPerConnection) {
      this.log({
        component: 'realtime',
        operation: 'rooms.sync',
        outcome: 'rejected',
        connectionId,
        requestedSubscriptions: authorizedRoomIds.length,
        limit: this.limits.maxSubscriptionsPerConnection,
      });
      return { accepted: false, roomIds: [...meta.roomIds] };
    }
    const next = new Set(authorizedRoomIds);

    for (const roomId of meta.roomIds) {
      if (!next.has(roomId)) this.removeIndex(this.roomConnections, roomId, connectionId);
    }
    for (const roomId of next) {
      if (!meta.roomIds.has(roomId)) this.addIndex(this.roomConnections, roomId, connectionId);
    }
    meta.roomIds = next;

    this.sendEvent(connectionId, {
      type: 'rooms.synced',
      streamId: 'control',
      reliable: true,
      payload: { roomIds: [...next] },
    });
    return { accepted: true, roomIds: [...next] };
  }

  async revokeRoom(userId: string, roomId: string): Promise<void> {
    const connectionIds = [...(this.userConnections.get(userId) ?? [])];
    for (const connectionId of connectionIds) {
      const meta = this.metadata.get(connectionId);
      if (!meta?.roomIds.delete(roomId)) continue;
      this.removeIndex(this.roomConnections, roomId, connectionId);
      this.sendEvent(connectionId, {
        type: 'room.access_revoked',
        streamId: `room:${roomId}`,
        reliable: true,
        payload: { roomId },
      });
    }
  }

  renew(connectionId: string, userId: string, leaseExpiresAt: number): boolean {
    const meta = this.metadata.get(connectionId);
    if (!meta || meta.userId !== userId || leaseExpiresAt <= this.now()) return false;
    meta.leaseExpiresAt = leaseExpiresAt;
    meta.authExpiringSent = false;
    return true;
  }

  hasRoomSubscription(connectionId: string, roomId: string): boolean {
    return this.metadata.get(connectionId)?.roomIds.has(roomId) ?? false;
  }

  canAcceptUser(userId: string): boolean {
    return !this.draining
      && (this.userConnections.get(userId)?.size ?? 0) < this.limits.maxConnectionsPerUser;
  }

  isUserOnline(userId: string): boolean {
    return (this.userConnections.get(userId)?.size ?? 0) > 0;
  }

  close(connectionId: string, code: number, reason: string): void {
    this.connections.get(connectionId)?.close(code, reason);
  }

  getIdentity(connectionId: string): { userId: string; leaseExpiresAt: number } | null {
    const meta = this.metadata.get(connectionId);
    return meta ? { userId: meta.userId, leaseExpiresAt: meta.leaseExpiresAt } : null;
  }

  notePong(connectionId: string): void {
    const meta = this.metadata.get(connectionId);
    if (meta) meta.lastPongAt = this.now();
  }

  noteDrain(connectionId: string): void {
    const meta = this.metadata.get(connectionId);
    if (meta) meta.outboundFrames = 0;
  }

  consumeCommandToken(connectionId: string): { allowed: boolean; retryAfterMs?: number } {
    const meta = this.metadata.get(connectionId);
    if (!meta) return { allowed: false };
    const now = this.now();
    const elapsedSeconds = Math.max(0, now - meta.commandTokenUpdatedAt) / 1000;
    meta.commandTokens = Math.min(
      this.limits.commandBurst,
      meta.commandTokens + elapsedSeconds * this.limits.commandsPerSecond,
    );
    meta.commandTokenUpdatedAt = now;
    if (meta.commandTokens < 1) {
      return { allowed: false, retryAfterMs: Math.ceil(1000 / this.limits.commandsPerSecond) };
    }
    meta.commandTokens -= 1;
    return { allowed: true };
  }

  noteInvalidFrame(connectionId: string): number {
    const meta = this.metadata.get(connectionId);
    if (!meta) return 0;
    meta.invalidFrames += 1;
    return meta.invalidFrames;
  }

  heartbeat(): void {
    const now = this.now();
    for (const [connectionId, connection] of this.connections) {
      const meta = this.metadata.get(connectionId);
      if (!meta) continue;
      if (meta.leaseExpiresAt <= now) {
        connection.close(1008, 'AUTH_EXPIRED');
        continue;
      }
      if (meta.leaseExpiresAt - now <= 30_000 && !meta.authExpiringSent) {
        meta.authExpiringSent = true;
        this.sendEvent(connectionId, {
          type: 'auth.expiring',
          streamId: 'control',
          reliable: true,
          payload: { leaseExpiresAt: new Date(meta.leaseExpiresAt).toISOString() },
        });
      }
      if (now - meta.lastPongAt > this.limits.heartbeatTimeoutMs) {
        connection.close(1001, 'HEARTBEAT_TIMEOUT');
        continue;
      }
      connection.ping();
    }
  }

  beginDrain(): void {
    this.draining = true;
    this.log({
      component: 'realtime',
      operation: 'server.drain',
      outcome: 'started',
      activeConnections: this.connections.size,
    });
    for (const connectionId of this.connections.keys()) {
      this.sendEvent(connectionId, {
        type: 'server.draining',
        streamId: 'control',
        reliable: true,
        payload: { retryAfterMs: this.limits.shutdownDrainMs },
      });
    }
  }

  finishDrain(): void {
    for (const connection of this.connections.values()) connection.close(1012, 'SERVICE_RESTART');
  }

  async publish<T extends RealtimeEventType>(publication: RealtimePublication<T>): Promise<PublishResult> {
    const recipients = this.resolveTargets(publication.target);
    let delivered = 0;
    let dropped = 0;
    for (const connectionId of recipients) {
      if (this.sendEvent(connectionId, publication)) delivered += 1;
      else dropped += 1;
    }
    return { delivered, dropped };
  }

  sendFrame(connectionId: string, frame: RealtimeServerFrame): boolean {
    return this.sendSerialized(connectionId, serializeServerFrame(frame), frame.reliable);
  }

  private sendEvent<T extends RealtimeEventType>(
    connectionId: string,
    event: {
      type: T;
      streamId: string;
      reliable: boolean;
      payload: EventPayload<T>;
      correlationId?: string;
    },
  ): boolean {
    const frame = makeEvent(event);
    return this.sendSerialized(connectionId, serializeServerFrame(frame), event.reliable);
  }

  private sendSerialized(connectionId: string, frame: string, reliable: boolean): boolean {
    const connection = this.connections.get(connectionId);
    const meta = this.metadata.get(connectionId);
    if (!connection || !meta) return false;
    if (connection.bufferedAmount === 0) meta.outboundFrames = 0;
    const frameBytes = Buffer.byteLength(frame);
    const queuedFrames = meta.outboundFrames + 1;
    if (
      connection.bufferedAmount + frameBytes > this.limits.maxOutboundBytes
      || queuedFrames > this.limits.maxOutboundFrames
    ) {
      this.log({
        component: 'realtime',
        operation: 'frame.send',
        outcome: reliable ? 'connection_closed' : 'dropped',
        reason: 'BACKPRESSURE',
        connectionId,
        reliable,
        bufferedBytes: connection.bufferedAmount,
        frameBytes,
        queuedFrames,
      });
      if (reliable) connection.close(1013, 'BACKPRESSURE');
      return false;
    }
    const sent = connection.send(frame);
    if (sent < 0) return false;
    meta.outboundFrames = connection.bufferedAmount > 0 ? queuedFrames : 0;
    return true;
  }

  private resolveTargets(target: RealtimePublication['target']): string[] {
    let connectionIds: string[];
    if (target.kind === 'connection') connectionIds = [target.connectionId];
    else if (target.kind === 'user') connectionIds = [...(this.userConnections.get(target.userId) ?? [])];
    else if (target.kind === 'room') connectionIds = [...(this.roomConnections.get(target.roomId) ?? [])];
    else connectionIds = [...this.connections.keys()];
    const exclude = 'excludeConnectionId' in target ? target.excludeConnectionId : undefined;
    return exclude ? connectionIds.filter((id) => id !== exclude) : connectionIds;
  }

  private async publishPresence(userId: string, status: 'online' | 'offline'): Promise<void> {
    const recipients = await this.presenceRecipients(userId);
    for (const recipientId of recipients) {
      await this.publish({
        target: { kind: 'user', userId: recipientId },
        type: 'presence.changed',
        streamId: `user:${recipientId}`,
        reliable: false,
        payload: { userId, status },
      });
    }
  }

  private addIndex(index: Map<string, Set<string>>, key: string, connectionId: string): void {
    const values = index.get(key) ?? new Set<string>();
    values.add(connectionId);
    index.set(key, values);
  }

  private removeIndex(index: Map<string, Set<string>>, key: string, connectionId: string): void {
    const values = index.get(key);
    if (!values) return;
    values.delete(connectionId);
    if (values.size === 0) index.delete(key);
  }
}
