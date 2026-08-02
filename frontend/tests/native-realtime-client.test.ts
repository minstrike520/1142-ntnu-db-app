import { describe, expect, test, vi } from 'vitest';
import { PROTOCOL_VERSION, type RealtimeMessage, type RealtimeServerFrame } from '@shared/realtime';
import { ChatSocket } from '@/lib/socket';

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readyState = 0;
  readonly sent: string[] = [];

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }

  serverClose(code: number, reason: string): void {
    this.close(code, reason);
  }

  serverSend(frame: RealtimeServerFrame): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const ticketMetadata = { protocol: 'near-chat.v1' as const, version: PROTOCOL_VERSION };
const message = (revision: string, content: string, messageId = 'message-1'): RealtimeMessage => ({
  messageId,
  roomId: 'room-1',
  senderId: 'user-1',
  content,
  isRecalled: false,
  sentAt: '2026-08-03T00:00:00.000Z',
  revision,
  sender: { userId: 'user-1', name: 'Alice' },
});

const event = (type: 'message.created', value: RealtimeMessage): RealtimeServerFrame => ({
  version: PROTOCOL_VERSION,
  kind: 'event',
  id: `event-${value.revision}`,
  type,
  streamId: 'room:room-1',
  reliable: true,
  payload: { revision: value.revision, message: value },
});

describe('native realtime client', () => {
  test('stops before upgrade and prompts reload when ticket protocol metadata mismatches', async () => {
    const webSocketFactory = vi.fn();
    const client = new ChatSocket('access-token', {
      ticketIssuer: async () => ({
        ticket: 'ticket',
        expiresAt: '2026-08-03T00:00:30.000Z',
        leaseExpiresAt: '2026-08-03T00:01:00.000Z',
        protocol: 'near-chat.v0',
        version: PROTOCOL_VERSION,
      } as never),
      webSocketFactory,
    });
    const mismatch = vi.fn();
    client.on('protocolMismatch', mismatch);

    client.connect();
    await flush();

    expect(mismatch).toHaveBeenCalledOnce();
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  test('reconnects with full jitter and resends the same pending command id', async () => {
    const sockets: FakeWebSocket[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const client = new ChatSocket('access-token', {
      ticketIssuer: async () => ({
        ...ticketMetadata,
        ticket: `ticket-${sockets.length}`,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      random: () => 0.5,
      schedule: ((callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      cancelSchedule: vi.fn() as unknown as typeof clearTimeout,
    });

    client.connect();
    await flush();
    sockets[0].open();
    const commandId = client.sendMessage({ roomId: 'room-1', content: 'hello' });
    expect(sockets[0].sent.some((frame) => JSON.parse(frame).id === commandId)).toBe(true);

    sockets[0].serverClose(1012, 'SERVICE_RESTART');
    const reconnect = timers.find((timer) => timer.delay === 250);
    expect(reconnect).toBeDefined();
    reconnect?.callback();
    await flush();
    sockets[1].open();

    expect(sockets[1].sent.some((frame) => JSON.parse(frame).id === commandId)).toBe(true);
    client.disconnect();
  });

  test('throttles repeated positive Typing indications', async () => {
    const socket = new FakeWebSocket();
    let now = 1_000;
    const client = new ChatSocket('access-token', {
      ticketIssuer: async () => ({
        ...ticketMetadata,
        ticket: 'ticket',
        expiresAt: new Date(now + 30_000).toISOString(),
        leaseExpiresAt: new Date(now + 60_000).toISOString(),
      }),
      webSocketFactory: () => socket as unknown as WebSocket,
      now: () => now,
    });
    client.connect();
    await flush();
    socket.open();
    socket.sent.length = 0;

    client.setTyping({ roomId: 'room-1', isTyping: true });
    now += 100;
    client.setTyping({ roomId: 'room-1', isTyping: true });
    client.setTyping({ roomId: 'room-1', isTyping: false });

    const typingFrames = socket.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === 'typing.set');
    expect(typingFrames).toHaveLength(2);
    expect(typingFrames.map((frame) => frame.payload.isTyping)).toEqual([true, false]);
    client.disconnect();
  });

  test('reannounces current Typing indication only after room subscriptions are restored', async () => {
    const socket = new FakeWebSocket();
    const client = new ChatSocket('access-token', {
      ticketIssuer: async () => ({
        ...ticketMetadata,
        ticket: 'ticket',
        expiresAt: '2026-08-03T00:00:30.000Z',
        leaseExpiresAt: '2026-08-03T00:01:00.000Z',
      }),
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    client.connect();
    await flush();
    socket.open();
    client.setTyping({ roomId: 'room-1', isTyping: true });
    socket.sent.length = 0;

    client.syncRooms();
    const sync = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === 'rooms.sync');
    socket.serverSend({
      version: PROTOCOL_VERSION,
      kind: 'ack',
      id: 'ack-sync',
      correlationId: sync.id,
      type: 'command.ack',
      streamId: 'control',
      reliable: true,
      payload: { roomIds: ['room-1'] },
    });

    expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual(
      expect.objectContaining({ type: 'typing.set', payload: { roomId: 'room-1', isTyping: true } }),
    );
    client.disconnect();
  });

  test('deduplicates duplicate and out-of-order message changes by revision', async () => {
    const socket = new FakeWebSocket();
    const client = new ChatSocket('access-token', {
      ticketIssuer: async () => ({
        ...ticketMetadata,
        ticket: 'ticket',
        expiresAt: '2026-08-03T00:00:30.000Z',
        leaseExpiresAt: '2026-08-03T00:01:00.000Z',
      }),
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const received = vi.fn();
    client.on('messageCreated', received);
    client.connect();
    await flush();
    socket.open();

    socket.serverSend(event('message.created', message('2', 'newest')));
    socket.serverSend(event('message.created', message('2', 'duplicate')));
    socket.serverSend(event('message.created', message('1', 'stale')));

    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ content: 'newest', revision: '2' }));
    client.disconnect();
  });

  test('buffers live changes until the fixed high-water delta window completes', async () => {
    const socket = new FakeWebSocket();
    const client = new ChatSocket('access-token', {
      ticketIssuer: async () => ({
        ...ticketMetadata,
        ticket: 'ticket',
        expiresAt: '2026-08-03T00:00:30.000Z',
        leaseExpiresAt: '2026-08-03T00:01:00.000Z',
      }),
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const contents: string[] = [];
    client.on('messageCreated', (value) => contents.push(value.content));
    client.connect();
    await flush();
    socket.open();
    const sync = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === 'rooms.sync');
    socket.serverSend({
      version: PROTOCOL_VERSION,
      kind: 'ack',
      id: 'ack-sync',
      correlationId: sync.id,
      type: 'command.ack',
      streamId: 'control',
      reliable: true,
      payload: { roomIds: ['room-1'] },
    });

    socket.serverSend(event('message.created', message('5', 'live', 'message-live')));
    expect(contents).toEqual([]);
    socket.serverSend({
      version: PROTOCOL_VERSION,
      kind: 'event',
      id: 'delta-1',
      type: 'message.delta',
      streamId: 'control',
      reliable: true,
      payload: {
        changes: [{
          type: 'message.created',
          revision: '4',
          message: message('4', 'recovered', 'message-recovered'),
        }],
        cursor: 'next-window',
        highWaterRevision: '4',
        complete: true,
      },
    });

    expect(contents).toEqual(['recovered', 'live']);
    client.disconnect();
  });

  test('discards a stale cursor and restarts recovery from an authorized snapshot', async () => {
    const socket = new FakeWebSocket();
    const client = new ChatSocket('access-token', {
      ticketIssuer: async () => ({
        ...ticketMetadata,
        ticket: 'ticket',
        expiresAt: '2026-08-03T00:00:30.000Z',
        leaseExpiresAt: '2026-08-03T00:01:00.000Z',
      }),
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    client.connect();
    await flush();
    socket.open();
    const firstSync = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === 'rooms.sync');
    socket.serverSend({
      version: PROTOCOL_VERSION,
      kind: 'ack',
      id: 'ack-first-sync',
      correlationId: firstSync.id,
      type: 'command.ack',
      streamId: 'control',
      reliable: true,
      payload: { roomIds: ['room-1'] },
    });
    socket.serverSend({
      version: PROTOCOL_VERSION,
      kind: 'event',
      id: 'delta-complete',
      type: 'message.delta',
      streamId: 'control',
      reliable: true,
      payload: { changes: [], cursor: 'stale-cursor', highWaterRevision: '4', complete: true },
    });
    socket.sent.length = 0;

    client.syncRooms();
    const nextSync = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === 'rooms.sync');
    socket.serverSend({
      version: PROTOCOL_VERSION,
      kind: 'ack',
      id: 'ack-next-sync',
      correlationId: nextSync.id,
      type: 'command.ack',
      streamId: 'control',
      reliable: true,
      payload: { roomIds: ['room-1'] },
    });
    const staleDelta = socket.sent.map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === 'message.delta' && frame.payload.cursor === 'stale-cursor');
    socket.serverSend({
      version: PROTOCOL_VERSION,
      kind: 'nack',
      id: 'nack-stale',
      correlationId: staleDelta.id,
      streamId: 'control',
      reliable: true,
      type: 'command.nack',
      payload: { code: 'CURSOR_INVALID', retryable: false, traceId: 'trace-stale' },
    });

    expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual(
      expect.objectContaining({ type: 'message.delta', payload: {} }),
    );
    client.disconnect();
  });
});
