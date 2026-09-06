import { describe, it, expect } from 'bun:test';
import pino from 'pino';
import { Server } from 'socket.io';
import { MessageType } from 'socket.io-adapter';
import {
  createRedisAdapter,
  realtimeChannel,
  REALTIME_CHANNEL,
} from '../../../src/realtime/redisAdapter';
import type { RedisManager, RedisMessageHandler, RedisOutcome } from '../../../src/utils/redis';

/**
 * A `RedisManager` whose channel is a `Map`, shared by every node in a test.
 *
 * Pub/sub is the only Redis feature this module leans on, and it is the one a
 * fake can carry honestly: hand every published string to every subscriber on
 * the channel. What that buys is the thing worth testing — two *real*
 * `socket.io` servers, each with a real `ClusterAdapter` beneath it, exchanging
 * real `ClusterMessage` frames. Routing, the JSON round trip, uid-based echo
 * suppression and the `except` set are then Socket.IO's own code running over
 * this module's transport, rather than a restatement of what this module was
 * written to do.
 *
 * Delivery is deferred by a microtask on purpose: a synchronous hand-off would
 * hide an ordering bug that a real round trip would expose.
 */
const createFakeRedis = () => {
  const handlers = new Map<string, Set<RedisMessageHandler>>();
  const published: { channel: string; message: string }[] = [];
  let failPublish = false;

  const redis = {
    async publish(channel: string, message: string): Promise<RedisOutcome<number>> {
      if (failPublish) {
        return { ok: false, error: new Error('publisher connection is not available') };
      }
      published.push({ channel, message });
      const listeners = [...(handlers.get(channel) ?? [])];
      await Promise.resolve();
      for (const listener of listeners) listener(message, channel);
      return { ok: true, value: listeners.length };
    },
    async subscribe(channel: string, handler: RedisMessageHandler): Promise<RedisOutcome<void>> {
      const existing = handlers.get(channel);
      if (existing) existing.add(handler);
      else handlers.set(channel, new Set([handler]));
      return { ok: true, value: undefined };
    },
    async unsubscribe(channel: string, handler: RedisMessageHandler): Promise<RedisOutcome<void>> {
      handlers.get(channel)?.delete(handler);
      return { ok: true, value: undefined };
    },
  } as unknown as RedisManager;

  return {
    redis,
    published,
    handlers,
    /** Deliver a raw string as if some other instance had published it. */
    inject(message: string) {
      for (const listener of [...(handlers.get(REALTIME_CHANNEL) ?? [])]) {
        listener(message, REALTIME_CHANNEL);
      }
    },
    setFailPublish(value: boolean) {
      failPublish = value;
    },
  };
};

const silent = pino({ level: 'silent' });

const createNode = (
  redis: RedisManager,
  instanceId: string,
  logger = silent,
  clusterId?: string,
): Server => new Server({ adapter: createRedisAdapter({ redis, instanceId, clusterId, logger }) });

/** Flush the microtask queue, so an awaited publish/dispatch chain completes. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Seat a stand-in socket on a node, in the given rooms.
 *
 * The in-memory adapter delivers by looking a room's socket ids up in
 * `nsp.sockets` and calling into the socket it finds, so a recorder placed
 * there observes delivery the way a genuine client would receive it — through
 * `Adapter#apply`, `except` filtering and the real Socket.IO encoder — rather
 * than through a spy on the code under test.
 */
const seatSocket = (io: Server, sid: string, rooms: string[]) => {
  const nsp = io.of('/');
  const received: string[] = [];
  const joined: string[] = [];
  let disconnected = false;

  const socket = {
    id: sid,
    // `Adapter#addSockets` hands the whole room list at once, so both take an
    // array here rather than a single room.
    join: (rooms: string[]) => joined.push(...rooms),
    leave: (rooms: string[]) => {
      for (const room of rooms) joined.splice(joined.indexOf(room), 1);
    },
    disconnect: () => {
      disconnected = true;
    },
    client: {
      writeToEngine: (packets: string[]) => received.push(...packets),
    },
  };

  (nsp.sockets as unknown as Map<string, unknown>).set(sid, socket);
  nsp.adapter.addAll(sid, new Set([sid, ...rooms]));

  return {
    received,
    joined,
    get disconnected() {
      return disconnected;
    },
  };
};

/** A pino stand-in that keeps the level and the details of every line. */
const recordingLogger = () => {
  const lines: { level: string; details: Record<string, unknown> }[] = [];
  const record = (level: string) => (details: Record<string, unknown>) =>
    lines.push({ level, details });
  return {
    lines,
    logger: {
      warn: record('warn'),
      debug: record('debug'),
      info: record('info'),
    } as unknown as pino.Logger,
  };
};

/** A BROADCAST frame from another server, addressed to `room_1`. */
const wellFormedBroadcast = (over: Record<string, unknown>): string =>
  JSON.stringify({
    uid: 'another-server',
    nsp: '/',
    type: MessageType.BROADCAST,
    data: {
      opts: { rooms: ['room_1'], except: [], flags: {} },
      packet: { type: 2, nsp: '/', data: ['user_typing', { roomId: 'room_1' }] },
    },
    ...over,
  });

describe('redis cluster adapter', () => {
  it('delivers a room broadcast to a socket on another instance', async () => {
    const fake = createFakeRedis();
    const alpha = createNode(fake.redis, 'alpha');
    const beta = createNode(fake.redis, 'beta');
    await settle();

    const onAlpha = seatSocket(alpha, 'socket-a', ['room_1']);
    const onBeta = seatSocket(beta, 'socket-b', ['room_1']);

    alpha.to('room_1').emit('user_typing', { roomId: 'room_1', userId: 'u1', isTyping: true });
    await settle();

    // A socket.io EVENT packet, as the real encoder produces it; the engine.io
    // frame prefix is added further down, past the adapter.
    const expected = '2["user_typing",{"roomId":"room_1","userId":"u1","isTyping":true}]';
    expect(onBeta.received).toEqual([expected]);
    // Exactly once on the origin too: alpha's own frame comes back on the
    // shared channel and is discarded by uid instead of broadcast a second time.
    expect(onAlpha.received).toEqual([expected]);

    expect(fake.published).toHaveLength(1);
    expect(fake.published[0].channel).toBe(REALTIME_CHANNEL);
  });

  it('leaves a room nobody on this instance has joined alone', async () => {
    const fake = createFakeRedis();
    const alpha = createNode(fake.redis, 'alpha');
    const beta = createNode(fake.redis, 'beta');
    await settle();
    const onBeta = seatSocket(beta, 'socket-b', ['room_other']);

    alpha.to('room_1').emit('user_typing', { roomId: 'room_1', userId: 'u1', isTyping: true });
    await settle();

    expect(onBeta.received).toEqual([]);
  });

  it('serialises an envelope carrying event, target, payload and source server', async () => {
    const fake = createFakeRedis();
    const alpha = createNode(fake.redis, 'alpha');
    createNode(fake.redis, 'beta');
    await settle();

    alpha.to('user_7').emit('emergency_alert', { userId: 'u7', message: 'help' });
    await settle();

    const frame = JSON.parse(fake.published[0].message);
    expect(frame.type).toBe(MessageType.BROADCAST);
    expect(frame.nsp).toBe('/');
    expect(typeof frame.uid).toBe('string');
    expect(frame.data.opts.rooms).toEqual(['user_7']);
    expect(frame.data.packet.data).toEqual(['emergency_alert', { userId: 'u7', message: 'help' }]);
  });

  it('preserves the excluded sender, so `socket.to(...)` still skips it across instances', async () => {
    const fake = createFakeRedis();
    const alpha = createNode(fake.redis, 'alpha');
    const beta = createNode(fake.redis, 'beta');
    await settle();
    const excluded = seatSocket(beta, 'socket-sender', ['room_9']);
    const other = seatSocket(beta, 'socket-other', ['room_9']);

    alpha
      .of('/')
      .except('socket-sender')
      .to('room_9')
      .emit('user_typing', { roomId: 'room_9', userId: 'u1', isTyping: true });
    await settle();

    expect(other.received).toHaveLength(1);
    expect(excluded.received).toEqual([]);
  });

  it('carries room membership changes and forced disconnects, not only events', async () => {
    const fake = createFakeRedis();
    const alpha = createNode(fake.redis, 'alpha');
    const beta = createNode(fake.redis, 'beta');
    await settle();
    const onBeta = seatSocket(beta, 'socket-b', ['user_1']);

    await alpha.in('user_1').socketsJoin('room_2');
    await settle();
    expect(onBeta.joined).toEqual(['room_2']);

    await alpha.in('user_1').socketsLeave('room_2');
    await settle();
    expect(onBeta.joined).toEqual([]);

    alpha.in('user_1').disconnectSockets(true);
    await settle();
    expect(onBeta.disconnected).toBe(true);

    expect(fake.published.map((entry) => JSON.parse(entry.message).type)).toEqual([
      MessageType.SOCKETS_JOIN,
      MessageType.SOCKETS_LEAVE,
      MessageType.DISCONNECT_SOCKETS,
    ]);
  });

  it('keeps delivering locally when Redis refuses the publish', async () => {
    const fake = createFakeRedis();
    const alpha = createNode(fake.redis, 'alpha');
    const beta = createNode(fake.redis, 'beta');
    await settle();
    const onAlpha = seatSocket(alpha, 'socket-a', ['room_1']);
    const onBeta = seatSocket(beta, 'socket-b', ['room_1']);

    fake.setFailPublish(true);
    alpha.to('room_1').emit('user_typing', { roomId: 'room_1', userId: 'u1', isTyping: true });
    await settle();

    // The local audience is unaffected; only the cross-instance hop is lost,
    // and nothing rejects out of the emit.
    expect(onAlpha.received).toHaveLength(1);
    expect(onBeta.received).toEqual([]);
    expect(fake.published).toHaveLength(0);
  });

  it('rejects a frame it cannot parse or route before the base class sees it', async () => {
    const fake = createFakeRedis();
    const { lines, logger } = recordingLogger();
    const beta = createNode(fake.redis, 'beta', logger);
    await settle();
    const onBeta = seatSocket(beta, 'socket-b', ['room_1']);
    lines.length = 0;

    // Each of these would otherwise reach `ClusterAdapter#onMessage`, whose
    // `switch` reads a `data` shape none of them carries.
    const rejected = [
      '{not json',
      'null',
      '"a string"',
      '{"uid":1,"nsp":"/","type":3}',
      '{"uid":"x","nsp":"/"}',
      // A type outside the MessageType enum.
      JSON.stringify({ uid: 'x', nsp: '/', type: 999 }),
    ];
    for (const raw of rejected) expect(() => fake.inject(raw)).not.toThrow();

    await settle();
    expect(onBeta.received).toEqual([]);
    expect(lines.at(-1)?.details.rejected).toBe(rejected.length);

    // A well-formed frame still gets through, so the guards reject on the
    // stated grounds rather than rejecting everything.
    fake.inject(wellFormedBroadcast({}));
    await settle();
    expect(onBeta.received).toHaveLength(1);
    expect(lines.at(-1)?.details.rejected).toBe(rejected.length);
  });

  it('passes another namespace and its own echo to the base class, uncounted', async () => {
    const fake = createFakeRedis();
    const { lines, logger } = recordingLogger();
    const beta = createNode(fake.redis, 'beta', logger);
    await settle();
    const onBeta = seatSocket(beta, 'socket-b', ['room_1']);
    lines.length = 0;

    // Provoke one frame from this node so its own server id can be read off it.
    beta.to('room_x').emit('realtime_ready');
    await settle();
    const ownUid = JSON.parse(fake.published.at(-1)!.message).uid;
    lines.length = 0;

    fake.inject(wellFormedBroadcast({ nsp: '/admin' }));
    fake.inject(wellFormedBroadcast({ uid: ownUid }));
    await settle();

    // Neither is delivered, and neither counts as an anomaly: they are
    // ordinary traffic on a channel the whole cluster shares.
    expect(onBeta.received).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('logs a dropped frame once, then counts it, and never logs the frame body', async () => {
    const fake = createFakeRedis();
    const { lines, logger } = recordingLogger();

    createNode(fake.redis, 'beta', logger);
    await settle();
    lines.length = 0;

    for (let i = 0; i < 4; i += 1) fake.inject('{not json');

    expect(lines.filter((line) => line.level === 'warn')).toHaveLength(1);
    expect(lines.filter((line) => line.level === 'debug')).toHaveLength(3);
    expect(lines[3].details.rejected).toBe(4);
    // Frames carry chat content, and a rejected one is attacker-shaped by
    // definition, so the body must never reach the log.
    for (const line of lines) {
      expect(JSON.stringify(line.details)).not.toContain('not json');
    }
  });

  describe('deployment isolation', () => {
    it('uses the bare channel by default and a scoped one when a cluster is named', () => {
      expect(realtimeChannel()).toBe(REALTIME_CHANNEL);
      expect(realtimeChannel('')).toBe(REALTIME_CHANNEL);
      expect(realtimeChannel('   ')).toBe(REALTIME_CHANNEL);
      expect(realtimeChannel('staging')).toBe(`${REALTIME_CHANNEL}:staging`);
      expect(realtimeChannel(' staging ')).toBe(`${REALTIME_CHANNEL}:staging`);
    });

    it('keeps two deployments sharing one Redis from reaching each other', async () => {
      // Redis pub/sub is not scoped by the logical database, so a shared server
      // is a shared channel; `seed.ts` also gives every seeded deployment the
      // same room ids, which is when that actually delivers to real sockets.
      const fake = createFakeRedis();
      const prod = createNode(fake.redis, 'prod-a', silent, 'production');
      const staging = createNode(fake.redis, 'staging-a', silent, 'staging');
      const shared = createNode(fake.redis, 'unscoped-a');
      await settle();

      const onProd = seatSocket(prod, 'socket-p', ['room_1']);
      const onStaging = seatSocket(staging, 'socket-s', ['room_1']);
      const onShared = seatSocket(shared, 'socket-u', ['room_1']);

      staging.to('room_1').emit('user_typing', { roomId: 'room_1', userId: 'u1', isTyping: true });
      await settle();

      // Staging's own audience is served; the other deployments are not.
      expect(onStaging.received).toHaveLength(1);
      expect(onProd.received).toEqual([]);
      expect(onShared.received).toEqual([]);
      expect(fake.published.at(-1)?.channel).toBe(`${REALTIME_CHANNEL}:staging`);
    });

    it('still reaches a second instance of the same deployment', async () => {
      const fake = createFakeRedis();
      const alpha = createNode(fake.redis, 'alpha', silent, 'production');
      const beta = createNode(fake.redis, 'beta', silent, 'production');
      await settle();
      const onBeta = seatSocket(beta, 'socket-b', ['room_1']);

      alpha.to('room_1').emit('user_typing', { roomId: 'room_1', userId: 'u1', isTyping: true });
      await settle();

      expect(onBeta.received).toHaveLength(1);
    });
  });

  describe('shutdown is this instance only', () => {
    // `publisher.shutdown` runs on SIGTERM. Before the adapter existed every
    // disconnect was local by construction; now the distinction has to be made
    // deliberately, and getting it wrong turns a rolling restart -- one
    // container stopped at a time -- into a cluster-wide disconnect.
    it('does not ask other instances to disconnect', async () => {
      const fake = createFakeRedis();
      const alpha = createNode(fake.redis, 'alpha');
      const beta = createNode(fake.redis, 'beta');
      await settle();
      const onAlpha = seatSocket(alpha, 'socket-a', []);
      const onBeta = seatSocket(beta, 'socket-b', []);

      alpha.local.disconnectSockets(true);
      await settle();

      expect(onAlpha.disconnected).toBe(true);
      expect(onBeta.disconnected).toBe(false);
      // Nothing on the wire at all: the frame is never published.
      expect(fake.published).toEqual([]);
    });

    it('still revokes one user everywhere, which is a different intent', async () => {
      const fake = createFakeRedis();
      const alpha = createNode(fake.redis, 'alpha');
      const beta = createNode(fake.redis, 'beta');
      await settle();
      const revoked = seatSocket(beta, 'socket-b', ['user_9']);
      const bystander = seatSocket(beta, 'socket-c', ['user_8']);

      alpha.in('user_9').disconnectSockets(true);
      await settle();

      expect(revoked.disconnected).toBe(true);
      expect(bystander.disconnected).toBe(false);
    });
  });

  it('subscribes to the channel on init and releases it on close', async () => {
    const fake = createFakeRedis();
    const io = createNode(fake.redis, 'alpha');
    await settle();

    expect(fake.handlers.get(REALTIME_CHANNEL)?.size).toBe(1);

    await io.of('/').adapter.close();
    expect(fake.handlers.get(REALTIME_CHANNEL)?.size).toBe(0);
  });

  it('starts without Redis and subscribes once it becomes reachable', async () => {
    const handlers = new Map<string, Set<RedisMessageHandler>>();
    let refuse = true;
    const redis = {
      async publish() {
        return { ok: true as const, value: 0 };
      },
      async subscribe(channel: string, handler: RedisMessageHandler) {
        if (refuse) return { ok: false as const, error: new Error('subscriber unavailable') };
        const existing = handlers.get(channel);
        if (existing) existing.add(handler);
        else handlers.set(channel, new Set([handler]));
        return { ok: true as const, value: undefined };
      },
      async unsubscribe() {
        return { ok: true as const, value: undefined };
      },
    } as unknown as RedisManager;

    // Socket.IO calls `init()` without awaiting it, so a refused subscription
    // must not reject: the manager's watchdog owns the retry.
    const io = createNode(redis, 'alpha');
    await settle();
    expect(handlers.size).toBe(0);

    // Creating a namespace runs `init()` on its own adapter, so the retry needs
    // no help beyond Redis answering.
    refuse = false;
    io.of('/second');
    await settle();
    expect(handlers.get(REALTIME_CHANNEL)?.size).toBe(1);
  });
});
