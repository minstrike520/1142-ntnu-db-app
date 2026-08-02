import { PROTOCOL_VERSION, type RealtimeEventType, type RealtimeMessage } from '@shared/realtime';
import type { MessageWithSender } from '@shared/types';

const toRealtimeMessage = (message: MessageWithSender): RealtimeMessage => ({
  messageId: message.messageId,
  roomId: message.roomId,
  senderId: message.senderId,
  content: message.content,
  ...(message.replyToId ? { replyToId: message.replyToId } : {}),
  isRecalled: message.isRecalled,
  sentAt: new Date(message.sentAt).toISOString(),
  revision: message.revision ?? '1',
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
    const command = JSON.parse(frame) as { id: string; type: string; payload: unknown; streamId: string };
    this.emitted.push({ event: command.type, payload: command.payload, id: command.id });
    if (command.type === 'message.delta') {
      this.serverEvent('message.delta', {
        changes: [],
        cursor: 'eyJ0ZXN0Ijp0cnVlfQ.signature',
        highWaterRevision: '0',
        complete: true,
      }, command.id);
    }
    this.serverAck(command.id, command.streamId, {});
  }

  close(code = 1000, reason = ''): void {
    this.readyState = MockNativeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }

  serverMessageCreated(message: MessageWithSender): void {
    const realtimeMessage = toRealtimeMessage(message);
    this.serverEvent('message.created', {
      revision: realtimeMessage.revision,
      message: realtimeMessage,
    });
  }

  serverMessageUpdated(message: MessageWithSender): void {
    const realtimeMessage = toRealtimeMessage(message);
    this.serverEvent('message.updated', {
      revision: realtimeMessage.revision,
      message: realtimeMessage,
    });
  }

  serverMessageRecalled(messageId: string, roomId = 'room-1', revision = '999'): void {
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
