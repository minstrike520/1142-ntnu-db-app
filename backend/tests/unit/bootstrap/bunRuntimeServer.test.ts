import { describe, it, expect, mock, afterEach } from 'bun:test';
import { createBunRuntimeServer, createRealtime } from '../../../src/bootstrap/realtime';
import { REALTIME_CHANNEL } from '../../../src/realtime/redisAdapter';
import type { Server as Engine } from '@socket.io/bun-engine';

const originalServe = Bun.serve;
const originalRedisUrl = process.env.REDIS_URL;

const stubEngine = () => ({
  handler: () => ({ websocket: {} }),
  handleRequest: mock(),
}) as unknown as Engine;

afterEach(() => {
  (Bun as unknown as { serve: typeof Bun.serve }).serve = originalServe;
  // `env()` re-reads `process.env` on every call, so a leaked `REDIS_URL` would
  // change what later files in this tier assemble.
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

describe('createBunRuntimeServer', () => {
  const stubServe = (stop: () => Promise<void>) => {
    const fake = {
      port: 4000,
      hostname: '0.0.0.0',
      stop: mock(stop),
    };
    (Bun as unknown as { serve: unknown }).serve = mock(() => fake);
    return fake;
  };

  it('reports the port as still bound while the drain is in flight', async () => {
    let releaseDrain!: () => void;
    const drained = new Promise<void>((resolve) => { releaseDrain = resolve; });
    stubServe(() => drained);

    const server = createBunRuntimeServer({
      app: { fetch: () => new Response('ok') },
      engine: stubEngine(),
    });
    server.listen(4000);
    expect(server.listening).toBe(true);

    let closed = false;
    server.close(() => { closed = true; });

    // The socket has not released the port yet, so the facade must not claim
    // it is free — and must refuse to bind it again.
    expect(server.listening).toBe(false);
    expect(server.address()).toEqual({ address: '0.0.0.0', family: 'IPv4', port: 4000 });
    expect(() => server.listen(4000)).toThrow('Cannot listen while the server is shutting down');
    expect(closed).toBe(false);

    releaseDrain();
    await drained;
    await Promise.resolve();

    expect(closed).toBe(true);
    expect(server.address()).toBeNull();
  });

  it('can bind again once the drain has completed', async () => {
    stubServe(() => Promise.resolve());

    const server = createBunRuntimeServer({
      app: { fetch: () => new Response('ok') },
      engine: stubEngine(),
    });
    server.listen(4000);
    await new Promise<void>((resolve) => server.close(resolve));

    expect(server.listening).toBe(false);
    server.listen(4000);
    expect(server.listening).toBe(true);
  });
});

describe('createRealtime', () => {
  it('configures CORS on the engine, which owns the handshake request', () => {
    const { engine } = createRealtime({
      config: { port: 4000, corsOrigins: ['http://localhost:3000'], instanceId: 'test-instance' },
      repositories: {
        roomMembers: { findByUser: mock(), findMember: mock() },
        friends: { getFriends: mock() },
      } as never,
      publisher: {
        bind: mock(),
        withRoomSubscriptionLock: mock(),
      } as never,
      // Never consulted: without `REDIS_URL` the in-memory adapter is installed
      // and the manager is not asked for a subscription.
      redis: {} as never,
    });

    // `io.bind(engine)` means Socket.IO never sees the raw request, so its own
    // `cors` option would silently do nothing.
    expect(engine.opts.cors).toEqual({
      origin: ['http://localhost:3000'],
      credentials: true,
    });
  });

  describe('cluster adapter', () => {
    const build = () => {
      const subscribed: string[] = [];
      const redis = {
        subscribe: async (channel: string) => {
          subscribed.push(channel);
          return { ok: true as const, value: undefined };
        },
        unsubscribe: async () => ({ ok: true as const, value: undefined }),
        publish: async () => ({ ok: true as const, value: 0 }),
      };
      const { io } = createRealtime({
        config: { port: 4000, corsOrigins: [], instanceId: 'test-instance' },
        repositories: {
          roomMembers: { findByUser: mock(), findMember: mock() },
          friends: { getFriends: mock() },
        } as never,
        publisher: { bind: mock(), withRoomSubscriptionLock: mock() } as never,
        redis: redis as never,
      });
      return { io, subscribed };
    };

    it('installs the Redis adapter when REDIS_URL is configured', async () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      const { subscribed } = build();

      // `init()` is not awaited by Socket.IO, so let the subscribe settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(subscribed).toEqual([REALTIME_CHANNEL]);
    });

    it('leaves the in-memory adapter in place when REDIS_URL is absent', async () => {
      delete process.env.REDIS_URL;
      const { subscribed } = build();

      await new Promise((resolve) => setTimeout(resolve, 0));
      // Nothing subscribed means nothing to supervise: a deployment without
      // Redis keeps exactly the single-node realtime it had before.
      expect(subscribed).toEqual([]);
    });
  });
});
