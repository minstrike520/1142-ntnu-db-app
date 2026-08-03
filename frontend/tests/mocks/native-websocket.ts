import { PROTOCOL_VERSION, type RealtimeEventType, type RealtimeMessage } from '@shared/realtime';
import type { MessageWithSender } from '@shared/types';
import { ME_ID, ME_NAME } from '../fixtures';

const toRealtimeMessage = (message: MessageWithSender, revision: string): RealtimeMessage => ({
  messageId: message.messageId,
  roomId: message.roomId,
  senderId: message.senderId,
  content: message.content,
  ...(message.replyToId ? { replyToId: message.replyToId } : {}),
  isRecalled: message.isRecalled,
  sentAt: new Date(message.sentAt).toISOString(),
  revision: message.revision ?? revision,
  sender: message.sender,
  ...(message.mentions ? { mentions: message.mentions } : {}),
  ...(message.attachments ? {
    attachments: message.attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      uploadedBy: attachment.uploadedBy,
      fileUrl: attachment.fileUrl,
      fileType: attachment.fileType,
      originalName: attachment.originalName,
      uploadedAt: new Date(attachment.uploadedAt).toISOString(),
    })),
  } : {}),
});

export class MockNativeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readonly protocol = 'near-chat.v1';
  readonly extensions = '';
  readonly binaryType = 'blob';
  bufferedAmount = 0;
  readyState = MockNativeWebSocket.CONNECTING;
  emitted: Array<{ event: string; payload: unknown; id: string }> = [];
  /** Server-managed monotonic revision, so a later change always supersedes an earlier one. */
  private revisionCounter = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    rememberWebSocket(this);
    queueMicrotask(() => {
      this.readyState = MockNativeWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(frame: string): void {
    const command = JSON.parse(frame) as {
      id: string;
      type: string;
      payload: Record<string, unknown>;
      streamId: string;
    };
    this.emitted.push({ event: command.type, payload: command.payload, id: command.id });
    if (command.type === 'message.delta') {
      this.serverEvent('message.delta', {
        changes: [],
        cursor: 'eyJ0ZXN0Ijp0cnVlfQ.signature',
        highWaterRevision: '0',
        complete: true,
      }, command.id);
    }
    // The real server ACKs a durable message mutation with the canonical
    // MessageMutationResult, and excludes the originating connection from the
    // room broadcast. The originating tab therefore converges through the ACK
    // alone — modelling the empty ACK here would let a duplicate render pass.
    this.serverAck(command.id, command.streamId, this.durableAckPayload(command));
  }

  private durableAckPayload(command: { id: string; type: string; payload: Record<string, unknown> }): unknown {
    if (command.type !== 'message.send'
      && command.type !== 'message.edit'
      && command.type !== 'message.recall') return {};

    const roomId = String(command.payload.roomId ?? 'room-1');
    const isRecall = command.type === 'message.recall';
    const messageId = command.type === 'message.send'
      ? `${roomId}-ack-${command.id}`
      : String(command.payload.messageId);
    const message: RealtimeMessage = {
      messageId,
      roomId,
      senderId: ME_ID,
      content: isRecall ? '' : String(command.payload.content ?? ''),
      ...(command.payload.replyToId ? { replyToId: String(command.payload.replyToId) } : {}),
      isRecalled: isRecall,
      sentAt: new Date().toISOString(),
      revision: this.allocateRevision(),
      sender: { userId: ME_ID, name: ME_NAME },
    };
    return { message, replayed: false, readAdvanced: command.type === 'message.send' };
  }

  private allocateRevision(): string {
    this.revisionCounter += 1;
    return String(this.revisionCounter);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = MockNativeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }

  serverMessageCreated(message: MessageWithSender): void {
    const realtimeMessage = toRealtimeMessage(message, this.allocateRevision());
    this.serverEvent('message.created', {
      revision: realtimeMessage.revision,
      message: realtimeMessage,
    });
  }

  serverMessageUpdated(message: MessageWithSender): void {
    // Must outrank the create, or the client's revision dedupe drops the update.
    const realtimeMessage = toRealtimeMessage(
      { ...message, revision: undefined },
      this.allocateRevision(),
    );
    this.serverEvent('message.updated', {
      revision: realtimeMessage.revision,
      message: realtimeMessage,
    });
  }

  serverMessageRecalled(messageId: string, roomId = 'room-1', revision = this.allocateRevision()): void {
    const message: RealtimeMessage = {
      messageId,
      roomId,
      senderId: 'm-1',
      content: '',
      isRecalled: true,
      sentAt: new Date().toISOString(),
      revision,
      sender: { userId: 'm-1', name: 'Member One' },
    };
    this.serverEvent('message.recalled', { revision, message });
  }

  serverTypingChanged(payload: { roomId: string; userId: string; isTyping: boolean }): void {
    this.serverEvent('typing.changed', {
      ...payload,
      expiresAt: new Date(Date.now() + 3_000).toISOString(),
    });
  }

  serverReadAdvanced(payload: { roomId: string; userId: string; messageId: string }): void {
    this.serverEvent('read.advanced', payload);
  }

  serverEvent(type: RealtimeEventType, payload: unknown, correlationId?: string): void {
    this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        version: PROTOCOL_VERSION,
        kind: 'event',
        id: `event-${Math.random()}`,
        ...(correlationId ? { correlationId } : {}),
        type,
        streamId: 'control',
        reliable: type !== 'typing.changed' && type !== 'presence.changed',
        payload,
      }),
    }));
  }

  countEmitted(event: string): number {
    return this.emitted.filter((entry) => entry.event === event).length;
  }

  private serverAck(correlationId: string, streamId: string, payload: unknown): void {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        version: PROTOCOL_VERSION,
        kind: 'ack',
        id: `ack-${correlationId}`,
        correlationId,
        type: 'command.ack',
        streamId,
        reliable: true,
        payload,
      }),
    })));
  }
}

let latestSocket: MockNativeWebSocket | null = null;

const rememberWebSocket = (socket: MockNativeWebSocket): void => {
  latestSocket = socket;
};

export const __getWebSocket = (): MockNativeWebSocket => {
  if (!latestSocket) throw new Error('No native WebSocket has been created');
  return latestSocket;
};

export const __resetWebSocket = (): void => {
  latestSocket = null;
  globalThis.WebSocket = MockNativeWebSocket as unknown as typeof WebSocket;
};
