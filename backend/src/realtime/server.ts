import { randomUUID } from 'node:crypto';
import { REALTIME_SUBPROTOCOL } from '@shared/realtime';
import type { RealtimeConnection, RealtimeManager } from './manager';
import type { WsTicketService } from './wsTicket';

interface FetchApp {
  fetch(request: Request): Response | Promise<Response>;
}

interface RealtimeSocketData {
  connectionId: string;
  userId: string;
  leaseExpiresAt: number;
}

interface CreateRealtimeServerOptions {
  app: FetchApp;
  tickets: WsTicketService;
  manager: RealtimeManager;
  allowedOrigins: readonly string[];
  handleCommand(connectionId: string, frame: string): Promise<void>;
  port?: number;
  hostname?: string;
}

export interface RealtimeServer {
  readonly port: number;
  stop(force?: boolean): Promise<void>;
}

const asConnection = (socket: Bun.ServerWebSocket<RealtimeSocketData>): RealtimeConnection => ({
  get bufferedAmount() {
    return socket.getBufferedAmount();
  },
  send: (frame) => socket.send(frame),
  close: (code, reason) => socket.close(code, reason),
  ping: () => socket.ping(),
});

const offeredProtocols = (request: Request): string[] =>
  (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean);

export const createRealtimeServer = (options: CreateRealtimeServerOptions): RealtimeServer => {
  const start = (port: number) => Bun.serve<RealtimeSocketData>({
    port,
    hostname: options.hostname ?? '0.0.0.0',
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname !== '/ws') return options.app.fetch(request);
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('WebSocket upgrade required', { status: 426 });
      }

      const origin = request.headers.get('origin');
      if (!origin || !options.allowedOrigins.includes(origin)) {
        return new Response('Origin rejected', { status: 403 });
      }
      if (!offeredProtocols(request).includes(REALTIME_SUBPROTOCOL)) {
        return new Response('Unsupported WebSocket protocol', {
          status: 426,
          headers: { 'Sec-WebSocket-Protocol': REALTIME_SUBPROTOCOL },
        });
      }

      const ticket = url.searchParams.get('ticket');
      if (!ticket) return new Response('Missing WebSocket ticket', { status: 401 });

      try {
        const claims = await options.tickets.consume(ticket);
        if (!options.manager.canAcceptUser(claims.userId)) {
          return new Response('Connection limit reached', { status: 429 });
        }
        const upgraded = bunServer.upgrade(request, {
          headers: { 'Sec-WebSocket-Protocol': REALTIME_SUBPROTOCOL },
          data: {
            connectionId: randomUUID(),
            userId: claims.userId,
            leaseExpiresAt: claims.leaseExp * 1000,
          },
        });
        return upgraded ? undefined : new Response('Upgrade failed', { status: 400 });
      } catch {
        return new Response('Invalid WebSocket ticket', { status: 401 });
      }
    },
    websocket: {
      perMessageDeflate: false,
      maxPayloadLength: options.manager.limits.maxFrameBytes,
      idleTimeout: Math.ceil(options.manager.limits.heartbeatTimeoutMs / 1000) + 10,
      sendPings: false,
      open(socket) {
        void options.manager.register(asConnection(socket), socket.data);
      },
      message(socket, message) {
        if (typeof message !== 'string') {
          socket.close(1003, 'BINARY_NOT_SUPPORTED');
          return;
        }
        if (Buffer.byteLength(message) > options.manager.limits.maxFrameBytes) {
          socket.close(1009, 'FRAME_TOO_LARGE');
          return;
        }
        void options.handleCommand(socket.data.connectionId, message);
      },
      close(socket) {
        void options.manager.remove(socket.data.connectionId);
      },
      pong(socket) {
        options.manager.notePong(socket.data.connectionId);
      },
      drain(socket) {
        options.manager.noteDrain(socket.data.connectionId);
      },
    },
  });

  const requestedPort = options.port ?? Number(process.env.PORT ?? 4000);
  let server: Bun.Server<RealtimeSocketData> | undefined;
  if (requestedPort !== 0) {
    server = start(requestedPort);
  } else {
    for (let attempt = 0; attempt < 20 && !server; attempt += 1) {
      const candidate = 20_000 + Math.floor(Math.random() * 30_000);
      try {
        server = start(candidate);
      } catch (error) {
        if ((error as { code?: string }).code !== 'EADDRINUSE') throw error;
      }
    }
  }
  if (!server) throw new Error('Unable to allocate an ephemeral realtime test port');

  const heartbeat = setInterval(
    () => options.manager.heartbeat(),
    options.manager.limits.heartbeatIntervalMs,
  );

  return {
    port: server.port ?? requestedPort,
    async stop(force = false) {
      clearInterval(heartbeat);
      if (!force) {
        options.manager.beginDrain();
        await new Promise((resolve) => setTimeout(resolve, options.manager.limits.shutdownDrainMs));
        options.manager.finishDrain();
      }
      await server.stop(true);
    },
  };
};
