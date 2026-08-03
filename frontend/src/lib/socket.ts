import {
  PROTOCOL_VERSION,
  REALTIME_LIMITS,
  REALTIME_SUBPROTOCOL,
  parseServerFrame,
  type RealtimeCommand,
  type RealtimeEvent,
  type RealtimeMessage,
  type RealtimeNack,
} from '@shared/realtime';
import type { ApiError, FriendRequest, MessageWithSender } from '@shared/types';
import { getApiBaseUrl, issueRealtimeTicket } from '@/lib/api';

type CommandType = RealtimeCommand['type'];
type CommandPayload<T extends CommandType> = Extract<RealtimeCommand, { type: T }>['payload'];

interface ClientEvents {
  connected: () => void;
  messageCreated: (message: MessageWithSender & { clientCommandId?: string }) => void;
  messageUpdated: (message: MessageWithSender) => void;
  messageRecalled: (payload: { messageId: string }) => void;
  typingChanged: (payload: { roomId: string; userId: string; isTyping: boolean; expiresAt: string }) => void;
  readAdvanced: (payload: { roomId: string; userId: string; messageId: string }) => void;
  emergencyAlert: (payload: { notificationId: string; userId: string; message: string }) => void;
  friendRequested: (payload: FriendRequest) => void;
  presenceChanged: (payload: { userId: string; status: 'online' | 'offline' }) => void;
  roomUpdated: (payload: { type: string; roomId: string; data: unknown }) => void;
  roomAccessRevoked: (payload: { roomId: string }) => void;
  error: (error: ApiError) => void;
  protocolMismatch: () => void;
  commandState: (payload: { commandId: string; state: 'retrying' | 'failed'; code?: string }) => void;
}

type Listener<K extends keyof ClientEvents> = ClientEvents[K];

interface PendingCommand {
  command: RealtimeCommand;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryCount: number;
}

interface ChatSocketOptions {
  webSocketFactory?: (url: string, protocol: string) => WebSocket;
  ticketIssuer?: typeof issueRealtimeTicket;
  now?: () => number;
  random?: () => number;
  schedule?: typeof setTimeout;
  cancelSchedule?: typeof clearTimeout;
}

const commandId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `command-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const toApiMessage = (message: RealtimeMessage): MessageWithSender => ({
  messageId: message.messageId,
  roomId: message.roomId,
  senderId: message.senderId,
  content: message.content,
  ...(message.replyToId ? { replyToId: message.replyToId } : {}),
  isRecalled: message.isRecalled,
  sentAt: new Date(message.sentAt),
  revision: message.revision,
  sender: message.sender,
  ...(message.mentions ? { mentions: message.mentions } : {}),
  ...(message.attachments ? {
    attachments: message.attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      uploadedBy: attachment.uploadedBy,
      fileUrl: attachment.fileUrl,
      fileType: attachment.fileType,
      originalName: attachment.originalName,
      uploadedAt: new Date(attachment.uploadedAt),
    })),
  } : {}),
});

const socketUrl = (ticket: string): string => {
  const url = new URL(getApiBaseUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.searchParams.set('ticket', ticket);
  return url.toString();
};

export class ChatSocket {
  private socket: WebSocket | null = null;
  private token: string;
  private manualClose = true;
  private connecting = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private serverRetryAfterMs: number | undefined;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly listeners = new Map<keyof ClientEvents, Set<(...args: never[]) => void>>();
  private deltaCursor: string | undefined;
  private recovering = false;
  private recoveryHighWater = '0';
  private readonly bufferedChanges: Array<Extract<RealtimeEvent, {
    type: 'message.created' | 'message.updated' | 'message.recalled';
  }>> = [];
  private readonly messageRevisions = new Map<string, bigint>();
  private readonly typingState = new Map<string, CommandPayload<'typing.set'>>();
  private lastTypingSentAt = 0;
  private readonly options: Required<ChatSocketOptions>;

  constructor(token: string, options: ChatSocketOptions = {}) {
    this.token = token;
    this.options = {
      webSocketFactory: options.webSocketFactory ?? ((url, protocol) => new WebSocket(url, protocol)),
      ticketIssuer: options.ticketIssuer ?? issueRealtimeTicket,
      now: options.now ?? (() => Date.now()),
      random: options.random ?? Math.random,
      schedule: options.schedule ?? setTimeout,
      cancelSchedule: options.cancelSchedule ?? clearTimeout,
    };
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  updateToken(token: string): void {
    this.token = token;
  }

  connect(): void {
    this.manualClose = false;
    void this.open();
  }

  disconnect(): void {
    this.manualClose = true;
    if (this.reconnectTimer) this.options.cancelSchedule(this.reconnectTimer);
    if (this.stableTimer) this.options.cancelSchedule(this.stableTimer);
    for (const pending of this.pending.values()) {
      if (pending.retryTimer) this.options.cancelSchedule(pending.retryTimer);
    }
    this.pending.clear();
    this.socket?.close(1000, 'CLIENT_CLOSED');
    this.socket = null;
  }

  on<K extends keyof ClientEvents>(event: K, listener: Listener<K>): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as (...args: never[]) => void);
    this.listeners.set(event, listeners);
    return () => this.off(event, listener);
  }

  off<K extends keyof ClientEvents>(event: K, listener: Listener<K>): void {
    this.listeners.get(event)?.delete(listener as (...args: never[]) => void);
  }

  syncRooms(): string {
    return this.sendCommand('rooms.sync', {}, 'control', true);
  }

  sendMessage(payload: CommandPayload<'message.send'>): string {
    return this.sendCommand('message.send', payload, `room:${payload.roomId}`, true);
  }

  editMessage(payload: CommandPayload<'message.edit'>): string {
    return this.sendCommand('message.edit', payload, `room:${payload.roomId}`, true);
  }

  recallMessage(payload: CommandPayload<'message.recall'>): string {
    return this.sendCommand('message.recall', payload, `room:${payload.roomId}`, true);
  }

  advanceRead(payload: CommandPayload<'read.advance'>): string {
    return this.sendCommand('read.advance', payload, `room:${payload.roomId}`, true);
  }

  setTyping(payload: CommandPayload<'typing.set'>): string | undefined {
    if (payload.isTyping) this.typingState.set(payload.roomId, payload);
    else this.typingState.delete(payload.roomId);
    const now = this.options.now();
    if (payload.isTyping && now - this.lastTypingSentAt < REALTIME_LIMITS.typingThrottleMs) return undefined;
    this.lastTypingSentAt = now;
    return this.sendCommand('typing.set', payload, `room:${payload.roomId}`, false);
  }

  private async open(): Promise<void> {
    if (this.manualClose || this.connecting || this.connected) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      window.addEventListener('online', () => void this.open(), { once: true });
      return;
    }
    this.connecting = true;
    try {
      const issued = await this.options.ticketIssuer(this.token);
      if (this.manualClose) return;
      if (issued.protocol !== REALTIME_SUBPROTOCOL || issued.version !== PROTOCOL_VERSION) {
        this.manualClose = true;
        this.emit('protocolMismatch');
        return;
      }
      const socket = this.options.webSocketFactory(socketUrl(issued.ticket), REALTIME_SUBPROTOCOL);
      this.socket = socket;
      socket.addEventListener('open', () => this.handleOpen(socket), { once: true });
      socket.addEventListener('message', (event) => this.handleMessage(String(event.data)));
      socket.addEventListener('close', (event) => this.handleClose(socket, event), { once: true });
      socket.addEventListener('error', () => {
        if (socket.readyState !== WebSocket.CLOSED) socket.close();
      });
    } catch {
      this.emit('error', { statusCode: 401, code: 'AUTH_REJECTED', message: 'AUTH_REJECTED' });
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private handleOpen(socket: WebSocket): void {
    if (this.socket !== socket || this.manualClose) return;
    this.emit('connected');
    this.stableTimer = this.options.schedule(() => {
      this.reconnectAttempt = 0;
    }, 30_000);
    for (const pending of this.pending.values()) {
      this.emit('commandState', { commandId: pending.command.id, state: 'retrying' });
      this.write(pending.command);
    }
    this.syncRooms();
  }

  private handleClose(socket: WebSocket, event: CloseEvent): void {
    if (this.socket !== socket) return;
    this.socket = null;
    if (this.stableTimer) this.options.cancelSchedule(this.stableTimer);
    for (const pending of this.pending.values()) {
      if (pending.retryTimer) this.options.cancelSchedule(pending.retryTimer);
      pending.retryTimer = undefined;
    }
    this.resetRecovery(false);
    if (this.manualClose) return;
    if (event.code === 1002 || event.reason === 'PROTOCOL_MISMATCH') {
      this.manualClose = true;
      this.emit('protocolMismatch');
      return;
    }
    if (event.reason === 'AUTH_REJECTED' || event.reason === 'CONNECTION_LIMIT') {
      this.manualClose = true;
      this.emit('error', { statusCode: 401, code: event.reason, message: event.reason });
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.reconnectTimer) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      window.addEventListener('online', () => this.scheduleReconnect(), { once: true });
      return;
    }
    const cap = Math.min(30_000, 500 * (2 ** this.reconnectAttempt));
    const delay = Math.max(this.serverRetryAfterMs ?? 0, Math.floor(this.options.random() * cap));
    this.serverRetryAfterMs = undefined;
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.options.schedule(() => {
      this.reconnectTimer = undefined;
      void this.open();
    }, delay);
  }

  private sendCommand<T extends CommandType>(
    type: T,
    payload: CommandPayload<T>,
    streamId: string,
    reliable: boolean,
  ): string {
    const command = {
      version: PROTOCOL_VERSION,
      kind: 'command',
      id: commandId(),
      type,
      streamId,
      reliable,
      payload,
    } as Extract<RealtimeCommand, { type: T }>;
    if (reliable) this.pending.set(command.id, { command, retryCount: 0 });
    this.write(command);
    return command.id;
  }

  private write(command: RealtimeCommand): void {
    if (!this.connected) return;
    this.socket?.send(JSON.stringify(command));
  }

  private handleMessage(raw: string): void {
    const parsed = parseServerFrame(raw);
    if (!parsed.success) {
      this.manualClose = true;
      this.socket?.close(1002, 'INVALID_SERVER_FRAME');
      this.emit('protocolMismatch');
      return;
    }
    if (parsed.data.kind === 'ack') this.handleAck(parsed.data.correlationId, parsed.data.payload);
    else if (parsed.data.kind === 'nack') this.handleNack(parsed.data);
    else this.handleEvent(parsed.data);
  }

  private handleAck(correlationId: string, payload: unknown): void {
    const pending = this.pending.get(correlationId);
    this.pending.delete(correlationId);
    if (!pending) return;
    const result = payload as { message?: RealtimeMessage; replayed?: boolean };
    if (pending.command.type === 'message.send' && result.message) {
      this.applyMessageEvent('message.created', result.message, correlationId);
    } else if (pending.command.type === 'message.edit' && result.message) {
      this.applyMessageEvent('message.updated', result.message);
    } else if (pending.command.type === 'message.recall' && result.message) {
      this.applyMessageEvent('message.recalled', result.message);
    } else if (pending.command.type === 'rooms.sync') {
      this.startRecovery();
      for (const typing of this.typingState.values()) {
        this.sendCommand('typing.set', typing, `room:${typing.roomId}`, false);
      }
    }
  }

  private handleNack(frame: RealtimeNack): void {
    const pending = this.pending.get(frame.correlationId);
    if (pending && frame.payload.retryable && pending.retryCount < REALTIME_LIMITS.maxCommandRetries) {
      pending.retryCount += 1;
      this.emit('commandState', {
        commandId: frame.correlationId,
        state: 'retrying',
        code: frame.payload.code,
      });
      const cap = Math.min(30_000, 500 * (2 ** pending.retryCount));
      const delay = Math.max(
        frame.payload.retryAfterMs ?? 0,
        Math.floor(this.options.random() * cap),
      );
      pending.retryTimer = this.options.schedule(() => {
        pending.retryTimer = undefined;
        this.write(pending.command);
      }, delay);
    } else {
      this.pending.delete(frame.correlationId);
      if (pending?.retryTimer) {
        this.options.cancelSchedule(pending.retryTimer);
        pending.retryTimer = undefined;
      }
      if (pending?.command.type === 'message.delta') {
        if (frame.payload.code === 'CURSOR_INVALID') {
          this.resetRecovery(false);
          this.deltaCursor = undefined;
          this.recovering = true;
          this.requestDelta();
        } else {
          this.resetRecovery(true);
        }
      }
      if (pending) {
        this.emit('commandState', {
          commandId: frame.correlationId,
          state: 'failed',
          code: frame.payload.code,
        });
      }
    }
    this.emit('error', {
      statusCode: frame.payload.retryable ? 503 : 400,
      code: frame.payload.code,
      message: frame.payload.code,
    });
  }

  private handleEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case 'message.created':
      case 'message.updated':
      case 'message.recalled':
        if (this.recovering && BigInt(event.payload.revision) > BigInt(this.recoveryHighWater)) {
          if (this.bufferedChanges.length >= REALTIME_LIMITS.maxRecoveryBufferedChanges) {
            this.socket?.close(1013, 'RECOVERY_BUFFER_EXCEEDED');
            return;
          }
          this.bufferedChanges.push(event);
        } else {
          this.applyMessageEvent(event.type, event.payload.message);
        }
        return;
      case 'message.delta':
        for (const change of event.payload.changes) this.applyMessageEvent(change.type, change.message);
        this.deltaCursor = event.payload.cursor ?? undefined;
        this.recoveryHighWater = event.payload.highWaterRevision;
        if (event.payload.complete) {
          this.recovering = false;
          this.bufferedChanges
            .sort((left, right) => Number(BigInt(left.payload.revision) - BigInt(right.payload.revision)))
            .forEach((change) => this.applyMessageEvent(change.type, change.payload.message));
          this.bufferedChanges.length = 0;
        } else {
          this.requestDelta();
        }
        return;
      case 'auth.expiring':
        void this.renewSession();
        return;
      case 'typing.changed':
        this.emit('typingChanged', event.payload);
        return;
      case 'read.advanced':
        this.emit('readAdvanced', event.payload);
        return;
      case 'presence.changed':
        this.emit('presenceChanged', event.payload);
        return;
      case 'room.updated':
        this.emit('roomUpdated', {
          type: event.payload.change,
          roomId: event.payload.roomId,
          data: event.payload.data,
        });
        return;
      case 'room.access_revoked':
        this.emit('roomAccessRevoked', event.payload);
        return;
      case 'friend.requested':
        this.emit('friendRequested', event.payload.data as FriendRequest);
        return;
      case 'emergency.alert':
        this.emit('emergencyAlert', event.payload);
        return;
      case 'server.draining':
        this.serverRetryAfterMs = event.payload.retryAfterMs;
        return;
      case 'session.ready':
      case 'rooms.synced':
        return;
    }
  }

  private applyMessageEvent(
    type: 'message.created' | 'message.updated' | 'message.recalled',
    message: RealtimeMessage,
    clientCommandId?: string,
  ): void {
    const revision = BigInt(message.revision);
    if ((this.messageRevisions.get(message.messageId) ?? BigInt(-1)) >= revision) return;
    if (!this.messageRevisions.has(message.messageId)
      && this.messageRevisions.size >= REALTIME_LIMITS.maxTrackedMessageRevisions) {
      const oldest = this.messageRevisions.keys().next().value;
      if (oldest) this.messageRevisions.delete(oldest);
    }
    this.messageRevisions.set(message.messageId, revision);
    const apiMessage = toApiMessage(message);
    if (type === 'message.created') this.emit('messageCreated', {
      ...apiMessage,
      ...(clientCommandId ? { clientCommandId } : {}),
    });
    else if (type === 'message.updated') this.emit('messageUpdated', apiMessage);
    else this.emit('messageRecalled', { messageId: message.messageId });
  }

  private startRecovery(): void {
    if (this.recovering) return;
    this.recovering = true;
    this.requestDelta();
  }

  private resetRecovery(flushBuffered: boolean): void {
    const buffered = this.bufferedChanges.splice(0);
    this.recovering = false;
    this.recoveryHighWater = '0';
    if (!flushBuffered) return;
    buffered
      .sort((left, right) => Number(BigInt(left.payload.revision) - BigInt(right.payload.revision)))
      .forEach((change) => this.applyMessageEvent(change.type, change.payload.message));
  }

  private requestDelta(): void {
    this.sendCommand(
      'message.delta',
      this.deltaCursor ? { cursor: this.deltaCursor } : {},
      'control',
      true,
    );
  }

  private async renewSession(): Promise<void> {
    try {
      const issued = await this.options.ticketIssuer(this.token);
      this.sendCommand('auth.renew', { ticket: issued.ticket }, 'control', true);
    } catch {
      this.socket?.close(1008, 'AUTH_REJECTED');
    }
  }

  private emit<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: Parameters<ClientEvents[K]>) => void)(...args);
    }
  }
}

export const createChatSocket = (token: string, options?: ChatSocketOptions): ChatSocket =>
  new ChatSocket(token, options);

export const syncRooms = (socket: ChatSocket): void => { socket.syncRooms(); };
export const sendMessage = (socket: ChatSocket, payload: {
  roomId: string;
  content: string;
  replyTo?: string;
  attachmentIds?: string[];
}): string => socket.sendMessage({
  roomId: payload.roomId,
  content: payload.content,
  ...(payload.replyTo ? { replyToId: payload.replyTo } : {}),
  ...(payload.attachmentIds ? { attachmentIds: payload.attachmentIds } : {}),
});
export const recallMessage = (socket: ChatSocket, payload: {
  roomId: string;
  messageId: string;
  expectedRevision?: string;
}): string => socket.recallMessage(payload);
export const updateMessage = (socket: ChatSocket, payload: {
  roomId: string;
  messageId: string;
  content: string;
  expectedRevision: string;
}): string => socket.editMessage(payload);
export const sendTyping = (socket: ChatSocket, payload: { roomId: string; isTyping: boolean }): void => {
  socket.setTyping(payload);
};
export const sendReadReceipt = (socket: ChatSocket, payload: { roomId: string; messageId: string }): void => {
  socket.advanceRead(payload);
};

export const onConnected = (socket: ChatSocket, handler: ClientEvents['connected']) => socket.on('connected', handler);
export const onMessageCreated = (socket: ChatSocket, handler: ClientEvents['messageCreated']) => socket.on('messageCreated', handler);
export const onMessageRecalled = (socket: ChatSocket, handler: ClientEvents['messageRecalled']) => socket.on('messageRecalled', handler);
export const onMessageUpdated = (socket: ChatSocket, handler: ClientEvents['messageUpdated']) => socket.on('messageUpdated', handler);
export const onTypingChanged = (socket: ChatSocket, handler: ClientEvents['typingChanged']) => socket.on('typingChanged', handler);
export const onReadAdvanced = (socket: ChatSocket, handler: ClientEvents['readAdvanced']) => socket.on('readAdvanced', handler);
export const onEmergencyAlert = (socket: ChatSocket, handler: ClientEvents['emergencyAlert']) => socket.on('emergencyAlert', handler);
export const onRealtimeError = (socket: ChatSocket, handler: ClientEvents['error']) => socket.on('error', handler);
export const onProtocolMismatch = (socket: ChatSocket, handler: ClientEvents['protocolMismatch']) => socket.on('protocolMismatch', handler);
export const onFriendRequested = (socket: ChatSocket, handler: ClientEvents['friendRequested']) => socket.on('friendRequested', handler);
export const onPresenceChanged = (socket: ChatSocket, handler: ClientEvents['presenceChanged']) => socket.on('presenceChanged', handler);
export const onRoomUpdated = (socket: ChatSocket, handler: ClientEvents['roomUpdated']) => socket.on('roomUpdated', handler);
export const onRoomAccessRevoked = (socket: ChatSocket, handler: ClientEvents['roomAccessRevoked']) => socket.on('roomAccessRevoked', handler);
export const onCommandState = (socket: ChatSocket, handler: ClientEvents['commandState']) => socket.on('commandState', handler);
