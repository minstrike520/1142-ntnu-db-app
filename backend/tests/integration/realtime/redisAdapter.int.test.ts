import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Server } from 'socket.io';
import { createRedisManager, type RedisManager } from '../../../src/utils/redis';
import {
  createRedisAdapter,
  realtimeChannel,
  REALTIME_CHANNEL,
} from '../../../src/realtime/redisAdapter';
import { createPresenceTracker } from '../../../src/realtime/presence';
import type { ChatServer } from '../../../src/realtime/authSocket';

/**
 * The one thing the unit tier cannot honestly claim: that two backend
 * instances really do exchange realtime frames over `near-chat-ws`.
 *
 * The unit suite runs both servers over a `Map` standing in for the channel,
 * which proves the routing and the envelope but assumes the transport. Here
 * each server gets its own `RedisManager` — its own publisher and subscriber
 * connections, as two containers would have — and the frames go through a real
 * Redis. What that pins is the part the fake cannot: that a JSON frame survives
 * `PUBLISH`/`SUBSCRIBE` intact, that the subscriber is delivered a frame it did
 * not publish, and that the publisher is not delivered its own.
 *
 * `REDIS_URL_TEST` defaults to the dev compose mapping, so `docker compose up
 * -d redis` from the repo root is enough to run it locally; CI provides the
 * same service in `ci-database.yml`.
 */
const url = process.env.REDIS_URL_TEST || 'redis://localhost:6385';

// Namespaced per run: `near-chat-ws` is a single cluster-wide channel by
// design, so two overlapping runs would otherwise see each other's frames.
const run = `it-${Math.random().toString(36).slice(2, 10)}`;
const room = (name: string): string => `room_${run}-${name}`;

/**
 * Seat a stand-in socket on a node, in the given room.
 *
 * The adapter delivers by looking a room's socket ids up in `nsp.sockets`, so a
 * recorder placed there observes delivery as a real client would receive it.
 */
const seatSocket = (io: Server, sid: string, rooms: string[]) => {
  const nsp = io.of('/');
  const received: string[] = [];
  (nsp.sockets as unknown as Map<string, unknown>).set(sid, {
    id: sid,
    client: { writeToEngine: (packets: string[]) => received.push(...packets) },
  });
  nsp.adapter.addAll(sid, new Set([sid, ...rooms]));
  return received;
};

/** Wait for a condition a Redis round trip has to satisfy first. */
const eventually = async (check: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(check()).toBe(true);
};

describe('redis cluster adapter against a real Redis', () => {
  let alphaRedis: RedisManager;
  let betaRedis: RedisManager;
  let alpha: Server;
  let beta: Server;

  beforeAll(async () => {
    alphaRedis = createRedisManager({ url });
    betaRedis = createRedisManager({ url });
    await Promise.all([alphaRedis.connect(), betaRedis.connect()]);
    if (!(await alphaRedis.ping()) || !(await betaRedis.ping())) {
      throw new Error(
        `Redis is not reachable at ${url}. Start it with \`docker compose up -d redis\`, or set REDIS_URL_TEST.`,
      );
    }

    alpha = new Server({
      adapter: createRedisAdapter({ redis: alphaRedis, instanceId: `${run}-alpha` }),
    });
    beta = new Server({
      adapter: createRedisAdapter({ redis: betaRedis, instanceId: `${run}-beta` }),
    });

    // `Namespace#_initAdapter` does not await `init()`, so the SUBSCRIBE may
    // still be in flight when the constructor returns.
    await eventually(() =>
      alphaRedis.status.subscribedChannels.includes(REALTIME_CHANNEL) &&
      betaRedis.status.subscribedChannels.includes(REALTIME_CHANNEL),
    );
  });

  afterAll(async () => {
    await Promise.all([alphaRedis.close(), betaRedis.close()]);
  });

  it('delivers one instance a room event published by another', async () => {
    const onBeta = seatSocket(beta, `${run}-b1`, [room('shared')]);

    alpha
      .to(room('shared'))
      .emit('user_typing', { roomId: room('shared'), userId: 'u1', isTyping: true });

    await eventually(() => onBeta.length > 0);
    expect(onBeta).toEqual([
      `2["user_typing",{"roomId":"${room('shared')}","userId":"u1","isTyping":true}]`,
    ]);
  });

  it('delivers the publishing instance its own event exactly once', async () => {
    const onAlpha = seatSocket(alpha, `${run}-a1`, [room('echo')]);
    const onBeta = seatSocket(beta, `${run}-b2`, [room('echo')]);

    alpha.to(room('echo')).emit('user_typing', { roomId: room('echo'), userId: 'u2', isTyping: true });

    // Beta receiving is the proof the frame completed a full round trip, so by
    // the time it lands alpha has had every chance to double-deliver.
    await eventually(() => onBeta.length > 0);
    expect(onAlpha).toHaveLength(1);
  });

  it('keeps a differently-scoped deployment out, even on another logical database', async () => {
    // The hazard a fake cannot show: Redis pub/sub ignores the database
    // number, so `/0` and `/1` of one server are the same channel space. Only
    // the channel name separates two deployments.
    const otherDbUrl = new URL(url);
    otherDbUrl.pathname = '/1';
    const stagingRedis = createRedisManager({ url: otherDbUrl.toString() });
    await stagingRedis.connect();
    const staging = new Server({
      adapter: createRedisAdapter({
        redis: stagingRedis,
        instanceId: `${run}-staging`,
        clusterId: `${run}-staging`,
      }),
    });
    await eventually(() =>
      stagingRedis.status.subscribedChannels.includes(realtimeChannel(`${run}-staging`)),
    );

    try {
      const onStaging = seatSocket(staging, `${run}-s1`, [room('isolated')]);
      const onBeta = seatSocket(beta, `${run}-b4`, [room('isolated')]);

      alpha
        .to(room('isolated'))
        .emit('user_typing', { roomId: room('isolated'), userId: 'u3', isTyping: true });

      // Beta arriving proves the frame really went through Redis, so staging
      // has had its chance to receive it and demonstrably did not.
      await eventually(() => onBeta.length > 0);
      expect(onStaging).toEqual([]);
    } finally {
      await stagingRedis.close();
    }
  });

  /**
   * The end-to-end shape of #476, which neither tier could show alone: the unit
   * suite mocks `io.to` and so only proves `broadcastStatus` decided to emit,
   * while the cases above prove the channel carries a frame somebody else
   * emitted. Here the real tracker announces a real transition and a friend
   * seated only on the *other* instance receives it.
   *
   * No `PresenceStore` on purpose. Which instance announces a transition is
   * decided by the leases and is covered in the unit tier; what is under test
   * here is only that the announcement leaves this instance and arrives at the
   * other, and a store would add a Redis 7.4 requirement (`HPEXPIRE`) this test
   * does not otherwise have.
   */
  it('carries a presence transition to a friend seated only on the other instance', async () => {
    const friendId = `${run}-f1`;
    const onBeta = seatSocket(beta, `${run}-b5`, [`user_${friendId}`]);
    const friendRepo = { getFriends: async () => [{ friend: { userId: friendId } }] };
    const tracker = createPresenceTracker({ graceMs: () => 0 });

    await tracker.trackUserConnection(
      alpha as unknown as ChatServer,
      `${run}-u1`,
      `${run}-sock-a`,
      friendRepo,
    );

    await eventually(() => onBeta.length > 0);
    expect(onBeta).toEqual([
      `2["user_status",{"userId":"${run}-u1","status":"online"}]`,
    ]);
  });

  it('carries a room subscription change to the other instance', async () => {
    const joined: string[] = [];
    const nsp = beta.of('/');
    const sid = `${run}-b3`;
    (nsp.sockets as unknown as Map<string, unknown>).set(sid, {
      id: sid,
      join: (rooms: string[]) => joined.push(...rooms),
    });
    nsp.adapter.addAll(sid, new Set([sid, `user_${run}`]));

    await alpha.in(`user_${run}`).socketsJoin(room('joined'));

    await eventually(() => joined.length > 0);
    expect(joined).toEqual([room('joined')]);
  });
});
