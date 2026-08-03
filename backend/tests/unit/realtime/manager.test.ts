import { describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION, parseServerFrame, type RealtimeServerFrame } from '@shared/realtime';
import { RealtimeManager, type RealtimeConnection } from '../../../src/realtime/manager';

class FakeConnection implements RealtimeConnection {
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  pings = 0;
  bufferedAmount = 0;

  send(frame: string): number {
    this.sent.push(frame);
    return Buffer.byteLength(frame);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  ping(): void { this.pings += 1; }
}

const eventTypes = (connection: FakeConnection) => connection.sent.flatMap((frame) => {
  const parsed = parseServerFrame(frame);
  return parsed.success && parsed.data.kind === 'event' ? [parsed.data.type] : [];
});

describe('RealtimeManager lifecycle and routing', () => {
  test('sends the auth-expiring notice and heartbeat ping in the same tick', async () => {
    const now = 1_000;
    const manager = new RealtimeManager({ now: () => now });
    const connection = new FakeConnection();
    await manager.register(connection, {
      connectionId: 'alice-1', userId: 'alice', leaseExpiresAt: now + 20_000,
    });
    connection.sent.length = 0;

    manager.heartbeat();

    expect(eventTypes(connection)).toContain('auth.expiring');
    expect(connection.pings).toBe(1);
  });

  test('bounds queued outbound frames independently from queued bytes', async () => {
    const manager = new RealtimeManager({ limits: { maxOutboundFrames: 2 } });
    const connection = new FakeConnection();
    await manager.register(connection, {
      connectionId: 'alice-1', userId: 'alice', leaseExpiresAt: Date.now() + 60_000,
    });
    manager.noteDrain('alice-1');
    connection.bufferedAmount = 1;
    const frame: RealtimeServerFrame = {
      version: PROTOCOL_VERSION,
      kind: 'ack',
      id: 'ack-1',
      correlationId: 'command-1',
      streamId: 'control',
      reliable: true,
      type: 'command.ack',
      payload: {},
    };

    expect(manager.sendFrame('alice-1', frame)).toBe(true);
    expect(manager.sendFrame('alice-1', frame)).toBe(true);
    expect(manager.sendFrame('alice-1', frame)).toBe(false);
    expect(connection.closes).toContainEqual({ code: 1013, reason: 'BACKPRESSURE' });
  });

  test('rejects a room subscription set over the configured limit', async () => {
    const manager = new RealtimeManager({ limits: { maxSubscriptionsPerConnection: 2 } });
    const connection = new FakeConnection();
    await manager.register(connection, {
      connectionId: 'alice-1', userId: 'alice', leaseExpiresAt: Date.now() + 60_000,
    });

    expect(manager.syncRooms('alice-1', ['room-1', 'room-2', 'room-3'])).toEqual({
      accepted: false,
      roomIds: [],
    });
    expect(manager.hasRoomSubscription('alice-1', 'room-1')).toBe(false);
  });

  test('routes by connection id and applies multi-session presence grace', async () => {
    const pendingTimers: Array<() => void> = [];
    const manager = new RealtimeManager({
      presenceRecipients: async (userId) => userId === 'alice' ? ['bob'] : [],
      schedule: (callback) => {
        pendingTimers.push(callback);
        return callback;
      },
      cancelSchedule: () => undefined,
    });
    const bob = new FakeConnection();
    const aliceTab1 = new FakeConnection();
    const aliceTab2 = new FakeConnection();

    await manager.register(bob, {
      connectionId: 'bob-1', userId: 'bob', leaseExpiresAt: Date.now() + 60_000,
    });
    await manager.register(aliceTab1, {
      connectionId: 'alice-1', userId: 'alice', leaseExpiresAt: Date.now() + 60_000,
    });
    await manager.register(aliceTab2, {
      connectionId: 'alice-2', userId: 'alice', leaseExpiresAt: Date.now() + 60_000,
    });

    expect(eventTypes(bob).filter((type) => type === 'presence.changed')).toHaveLength(1);

    manager.syncRooms('alice-1', ['room-1']);
    manager.syncRooms('alice-2', ['room-1']);
    await manager.publish({
      target: { kind: 'room', roomId: 'room-1', excludeConnectionId: 'alice-1' },
      type: 'room.updated',
      streamId: 'room:room-1',
      reliable: true,
      payload: { roomId: 'room-1', change: 'RENAMED', data: {} },
    });
    expect(eventTypes(aliceTab1)).not.toContain('room.updated');
    expect(eventTypes(aliceTab2)).toContain('room.updated');

    await manager.remove('alice-1');
    expect(pendingTimers).toHaveLength(0);
    await manager.remove('alice-2');
    expect(pendingTimers).toHaveLength(1);
    await pendingTimers[0]();
    expect(eventTypes(bob).filter((type) => type === 'presence.changed')).toHaveLength(2);
  });
});
