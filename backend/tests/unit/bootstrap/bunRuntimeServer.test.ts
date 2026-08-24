import { describe, it, expect, mock, afterEach } from 'bun:test';
import { createBunRuntimeServer, createRealtime } from '../../../src/bootstrap/realtime';
import type { Server as Engine } from '@socket.io/bun-engine';

const originalServe = Bun.serve;

const stubEngine = () => ({
  handler: () => ({ websocket: {} }),
  handleRequest: mock(),
}) as unknown as Engine;

afterEach(() => {
  (Bun as unknown as { serve: typeof Bun.serve }).serve = originalServe;
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
      config: { port: 4000, corsOrigins: ['http://localhost:3000'] },
      repositories: {
        roomMembers: { findByUser: mock(), findMember: mock() },
        friends: { getFriends: mock() },
      } as never,
      publisher: {
        bind: mock(),
        withRoomSubscriptionLock: mock(),
      } as never,
    });

    // `io.bind(engine)` means Socket.IO never sees the raw request, so its own
    // `cors` option would silently do nothing.
    expect(engine.opts.cors).toEqual({
      origin: ['http://localhost:3000'],
      credentials: true,
    });
  });
});
