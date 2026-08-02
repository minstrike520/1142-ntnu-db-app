import { describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION, parseServerFrame } from '@shared/realtime';
import { RealtimeCommandHandler } from '../../../src/realtime/commandHandler';
import { RealtimeManager, type RealtimeConnection } from '../../../src/realtime/manager';
import { WsTicketService } from '../../../src/realtime/wsTicket';

class FakeConnection implements RealtimeConnection {
  sent: string[] = [];
  closes: Array<{ code: number; reason: string }> = [];
  bufferedAmount = 0;
  send(frame: string) { this.sent.push(frame); return frame.length; }
  close(code: number, reason: string) { this.closes.push({ code, reason }); }
  ping() {}
}

const frames = (connection: FakeConnection) => connection.sent.map((value) => {
  const parsed = parseServerFrame(value);
  if (!parsed.success) throw new Error(parsed.code);
  return parsed.data;
});

describe('RealtimeCommandHandler', () => {
  test('replays an ACK-lost auth renewal after reconnecting as the same user', async () => {
    const now = Date.now();
    const manager = new RealtimeManager({ now: () => now });
    const tickets = new WsTicketService({
      now: () => new Date(now),
      secret: 'test',
    });
    const service = {
      sendMessage: async () => { throw new Error('unused'); },
      editMessage: async () => { throw new Error('unused'); },
      recallMessage: async () => { throw new Error('unused'); },
      getMessageDelta: async () => ({ changes: [], cursor: 'cursor', highWaterRevision: '0', complete: true }),
      advanceReadPosition: async (_userId: string, _connectionId: string, _roomId: string, messageId: string) => ({ messageId, advanced: true }),
    };
    const handler = new RealtimeCommandHandler({
      manager,
      tickets,
      listAuthorizedRoomIds: async () => [],
      service,
      now: () => now,
    });
    const issued = await tickets.issue({
      userId: 'alice',
      name: 'Alice',
      exp: Math.floor(now / 1000) + 60,
    });
    const command = JSON.stringify({
      version: PROTOCOL_VERSION,
      kind: 'command',
      id: 'renew-1',
      type: 'auth.renew',
      streamId: 'control',
      reliable: true,
      payload: { ticket: issued.ticket },
    });

    const first = new FakeConnection();
    await manager.register(first, {
      connectionId: 'alice-1', userId: 'alice', leaseExpiresAt: now + 30_000,
    });
    await handler.handle('alice-1', command);
    expect(frames(first).some((frame) => frame.kind === 'ack' && frame.correlationId === 'renew-1')).toBe(true);

    await manager.remove('alice-1');
    const reconnected = new FakeConnection();
    await manager.register(reconnected, {
      connectionId: 'alice-2', userId: 'alice', leaseExpiresAt: now + 30_000,
    });
    await handler.handle('alice-2', command);
    expect(frames(reconnected).some(
      (frame) => frame.kind === 'ack' && frame.correlationId === 'renew-1',
    )).toBe(true);
  });

  test('syncs authoritative rooms, ACKs commands, and delivers expiring typing only to subscribers', async () => {
    const now = Date.now();
    const manager = new RealtimeManager({ now: () => now });
    const alice = new FakeConnection();
    const bob = new FakeConnection();
    await manager.register(alice, { connectionId: 'alice-1', userId: 'alice', leaseExpiresAt: now + 60_000 });
    await manager.register(bob, { connectionId: 'bob-1', userId: 'bob', leaseExpiresAt: now + 60_000 });
    manager.syncRooms('bob-1', ['room-1']);

    const handler = new RealtimeCommandHandler({
      manager,
      tickets: new WsTicketService({ secret: 'test' }),
      listAuthorizedRoomIds: async (userId) => userId === 'alice' ? ['room-1'] : [],
      service: {
        sendMessage: async () => { throw new Error('unused'); },
        editMessage: async () => { throw new Error('unused'); },
        recallMessage: async () => { throw new Error('unused'); },
        getMessageDelta: async () => ({ changes: [], cursor: 'cursor', highWaterRevision: '0', complete: true }),
        advanceReadPosition: async (_userId, _connectionId, _roomId, messageId) => ({ messageId, advanced: true }),
      },
      now: () => now,
    });

    await handler.handle('alice-1', JSON.stringify({
      version: PROTOCOL_VERSION,
      kind: 'command',
      id: 'sync-1',
      type: 'rooms.sync',
      streamId: 'control',
      reliable: true,
      payload: { roomIds: ['room-not-authorized'] },
    }));
    expect(frames(alice).find((frame) => frame.kind === 'ack' && frame.correlationId === 'sync-1')).toBeDefined();
    expect(manager.hasRoomSubscription('alice-1', 'room-1')).toBe(true);
    expect(manager.hasRoomSubscription('alice-1', 'room-not-authorized')).toBe(false);

    await handler.handle('alice-1', JSON.stringify({
      version: PROTOCOL_VERSION,
      kind: 'command',
      id: 'typing-1',
      type: 'typing.set',
      streamId: 'room:room-1',
      reliable: false,
      payload: { roomId: 'room-1', isTyping: true },
    }));
    const typing = frames(bob).find((frame) => frame.kind === 'event' && frame.type === 'typing.changed');
    expect(typing).toMatchObject({
      kind: 'event',
      reliable: false,
      payload: { roomId: 'room-1', userId: 'alice', isTyping: true },
    });

    await handler.handle('alice-1', JSON.stringify({
      version: PROTOCOL_VERSION,
      kind: 'command',
      id: 'invalid-send-1',
      type: 'message.send',
      streamId: 'room:room-1',
      reliable: true,
      payload: { roomId: 'room-1', content: '' },
    }));
    expect(frames(alice).find(
      (frame) => frame.kind === 'nack' && frame.correlationId === 'invalid-send-1',
    )).toMatchObject({ payload: { code: 'INVALID_PAYLOAD', retryable: false } });
  });
});
