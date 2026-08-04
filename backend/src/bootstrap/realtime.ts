import { createServer, type Server as HttpServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Server } from 'socket.io';
import type { Hono } from 'hono';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/types';
import type { AppConfig } from './config';
import type { Repositories } from './repositories';
import type { Services } from './services';
import type { ChatServer } from '../realtime/authSocket';
import { attachSocketAuth } from '../realtime/authSocket';
import { attachSockets } from '../realtime/socketServer';

/**
 * The `node:http` server that fronts the Hono app.
 *
 * Socket.IO needs a real Node server to attach its upgrade handling to, which
 * is why Hono is adapted through `getRequestListener` rather than served
 * directly.
 */
export const createHttpServer = (honoApp: Hono): HttpServer =>
  createServer(getRequestListener(honoApp.fetch));

export interface CreateRealtimeDeps {
  httpServer: HttpServer;
  config: AppConfig;
  services: Services;
  repositories: Repositories;
}

/**
 * The Socket.IO server, sharing a port with the REST API, with auth and event
 * handlers attached.
 */
export const createRealtime = ({
  httpServer,
  config,
  services,
  repositories,
}: CreateRealtimeDeps): ChatServer => {
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: config.corsOrigins, credentials: true },
  }) as ChatServer;

  attachSocketAuth(io);
  attachSockets(io, {
    messageService: services.message,
    messageRepository: repositories.messages,
    roomMemberRepository: repositories.roomMembers,
    friendRepository: repositories.friends,
  });

  return io;
};
