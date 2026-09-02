import { Server as Engine } from '@socket.io/bun-engine';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/types';
import type { AppConfig } from './config';
import type { Repositories } from './repositories';
import type { ChatServer } from '../realtime/authSocket';
import { attachSocketAuth } from '../realtime/authSocket';
import { attachSockets } from '../realtime/socketServer';
import type { RealtimePublisher } from '../realtime/publisher';
import { createRedisAdapter } from '../realtime/redisAdapter';
import type { RedisManager } from '../utils/redis';
import { env } from '../config/env';

export interface CreateRealtimeDeps {
  config: AppConfig;
  repositories: Repositories;
  publisher: RealtimePublisher;
  redis: RedisManager;
}

export interface RealtimeRuntime {
  io: ChatServer;
  engine: Engine;
}

/**
 * Build the Socket.IO layer without binding it to an HTTP implementation.
 * Bun's server is created only when the composition root starts listening.
 */
export const createRealtime = ({
  config,
  repositories,
  publisher,
  redis,
}: CreateRealtimeDeps): RealtimeRuntime => {
  // CORS must be configured on the engine, not on the Socket.IO server: once
  // `io.bind(engine)` is used, Socket.IO never sees the raw handshake request,
  // so its own `cors` option is dead configuration. The polling handshake is
  // the first transport a browser tries, and it is a cross-origin request from
  // the frontend origin, so without these headers no session is ever created.
  const engine = new Engine({
    path: '/socket.io/',
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1_000_000,
    cors: { origin: config.corsOrigins, credentials: true },
  });
  // No `REDIS_URL` means no cluster adapter at all, mirroring the choice
  // `bootstrap/presence.ts` makes for presence: a deployment that has opted out
  // of Redis keeps exactly the single-node realtime it had before Redis
  // existed, with the in-memory adapter and no subscription to supervise.
  //
  // Passed as a constructor option rather than through `io.adapter(...)`, which
  // would build the default adapter first and then re-init every namespace.
  const { redisUrl } = env();
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(
    redisUrl
      ? { adapter: createRedisAdapter({ redis, instanceId: config.instanceId }) }
      : {},
  ) as ChatServer;

  io.bind(engine);
  publisher.bind(io);
  attachSocketAuth(io);
  attachSockets(io, {
    roomMemberRepository: repositories.roomMembers,
    friendRepository: repositories.friends,
    withRoomSubscriptionLock: publisher.withRoomSubscriptionLock,
  });

  return { io, engine };
};

export interface BunRuntimeServer {
  readonly listening: boolean;
  listen(port: string | number, hostname?: string, callback?: () => void): void;
  close(callback?: () => void): void;
  address(): { address: string; family: string; port: number } | null;
}

export interface CreateBunRuntimeServerDeps {
  app: { fetch(request: Request, env?: unknown): Response | Promise<Response> };
  engine: Engine;
  idleTimeout?: number;
}

/**
 * A small Node-shaped facade around Bun.serve. The facade keeps the existing
 * test harness stable (`listen`, `address`, `close`) while production traffic
 * uses one Bun server for both Hono and Socket.IO.
 */
export const createBunRuntimeServer = ({
  app,
  engine,
  idleTimeout = 60,
}: CreateBunRuntimeServerDeps): BunRuntimeServer => {
  let bunServer: Bun.Server<unknown> | undefined;
  // The socket keeps its port during the drain window. Tracking that window
  // explicitly is what lets `listening` report "not accepting new work" while
  // `address()` still reports the port that is genuinely still bound.
  let draining = false;
  const engineHandler = engine.handler();

  return {
    get listening() {
      return bunServer !== undefined && !draining;
    },

    listen(port, hostname = '0.0.0.0', callback) {
      if (draining) {
        // Binding again before the previous socket has released the port would
        // fail with EADDRINUSE at a point where the caller cannot recover.
        throw new Error('Cannot listen while the server is shutting down');
      }
      if (bunServer) {
        callback?.();
        return;
      }

      bunServer = Bun.serve({
        port,
        hostname,
        idleTimeout,
        websocket: engineHandler.websocket,
        fetch(request, server) {
          const pathname = new URL(request.url).pathname;
          if (pathname === '/socket.io/' || pathname === '/socket.io') {
            return engine.handleRequest(request, server);
          }
          return app.fetch(request, server);
        },
      });
      callback?.();
    },

    close(callback) {
      const current = bunServer;
      if (!current) {
        callback?.();
        return;
      }
      // Drain active HTTP work first. A hard stop remains as a bounded
      // fallback so a stuck websocket cannot hold deployment forever.
      // The reference is kept until the drain resolves so the facade never
      // claims the port is free while it is still bound.
      draining = true;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (bunServer === current) bunServer = undefined;
        draining = false;
        callback?.();
      };
      void current.stop().finally(finish);
      const forceStop = setTimeout(() => {
        if (!finished) void current.stop(true).finally(finish);
      }, 10_000);
      forceStop.unref?.();
    },

    address() {
      if (!bunServer) return null;
      if (bunServer.port === undefined || bunServer.hostname === undefined) return null;
      return {
        address: bunServer.hostname,
        family: 'IPv4',
        port: bunServer.port,
      };
    },
  };
};
