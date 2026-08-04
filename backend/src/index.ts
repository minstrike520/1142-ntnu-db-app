import db from "./models/db";
import { createConfig } from "./bootstrap/config";
import { createRepositories } from "./bootstrap/repositories";
import { createServices } from "./bootstrap/services";
import { createHttpApp } from "./bootstrap/httpApp";
import { createHttpServer, createRealtime } from "./bootstrap/realtime";
import { startJobs } from "./bootstrap/jobs";
import { startServer } from "./bootstrap/start";
import type { ChatServer } from "./realtime/authSocket";

/**
 * Composition root.
 *
 * Assembly runs in dependency order — config, repositories, services, HTTP app,
 * HTTP server, Socket.IO — with one knot: the services emit through Socket.IO,
 * but Socket.IO cannot exist until there is an HTTP server, which serves the
 * routes that those same services back. `getIo` is what unties it; the reasoning
 * is in `bootstrap/services.ts`.
 */
const config = createConfig();
const repositories = createRepositories(db);

let pendingIo: ChatServer | undefined;
const getIo = (): ChatServer => {
  if (!pendingIo) {
    throw new Error("Socket.IO server used before it was created");
  }
  return pendingIo;
};

const services = createServices({ repositories, getIo });
const honoApp = createHttpApp({ services, config });
const server = createHttpServer(honoApp);

pendingIo = createRealtime({ httpServer: server, config, services, repositories });

// Re-bound as a definitely-assigned const so the export keeps the type it always
// had; `pendingIo` is optional only to express the window before assignment.
const io: ChatServer = pendingIo;

// The Node HTTP server under a second name, kept because the E2E suite hands
// `app` to supertest.
const app = server;

if (require.main === module) {
  startJobs({ repositories, services });
  void startServer({ httpServer: server, config });
}

export { app, honoApp, server, io };
