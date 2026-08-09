import { Server as Engine } from '@socket.io/bun-engine';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/types';
import type { AppConfig } from './config';
import type { Repositories } from './repositories';
import type { ChatServer } from '../realtime/authSocket';
import { attachSocketAuth } from '../realtime/authSocket';
import { attachSockets } from '../realtime/socketServer';
import type { RealtimePublisher } from '../realtime/publisher';

export interface CreateRealtimeDeps {
  config: AppConfig;
  repositories: Repositories;
  publisher: RealtimePublisher;
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
}: CreateRealtimeDeps): RealtimeRuntime => {
  const engine = new Engine({
    path: '/socket.io/',
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1_000_000,
  });
  const io = new Server<ClientToServerEvents, ServerToClientEvents>({
    cors: { origin: config.corsOrigins, credentials: true },
  }) as ChatServer;

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
  const engineHandler = engine.handler();

  return {
    get listening() {
      return bunServer !== undefined;
    },

    listen(port, hostname = '0.0.0.0', callback) {
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
      bunServer = undefined;
      if (!current) {
        callback?.();
        return;
      }
      // Drain active HTTP work first. A hard stop remains as a bounded
      // fallback so a stuck websocket cannot hold deployment forever.
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
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
