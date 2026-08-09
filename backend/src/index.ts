import db from './models/db';
import { createConfig } from './bootstrap/config';
import { createRepositories } from './bootstrap/repositories';
import { createServices } from './bootstrap/services';
import { createHttpApp } from './bootstrap/httpApp';
import { createBunRuntimeServer, createRealtime } from './bootstrap/realtime';
import { createRealtimePublisher } from './realtime/publisher';
import { createHttpCompatibilityServer } from './bootstrap/httpCompat';
import { startJobs } from './bootstrap/jobs';
import { startServer } from './bootstrap/start';

/**
 * Composition root.
 *
 * Production has one Bun server for Hono and Socket.IO. `app` remains a small
 * Node-shaped compatibility server solely for the existing supertest suite;
 * it is never used by the production listener.
 */
const config = createConfig();
const repositories = createRepositories(db);
const publisher = createRealtimePublisher();
const services = createServices({ repositories, publisher });
const honoApp = createHttpApp({ services, config });
const realtime = createRealtime({ config, repositories, publisher });
const server = createBunRuntimeServer({ app: honoApp, engine: realtime.engine });
const app = createHttpCompatibilityServer(honoApp);
const io = realtime.io;

if (require.main === module) {
  const stopJobs = startJobs({ repositories, services });
  void startServer({ server, config });
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopJobs();
    publisher.shutdown(signal);
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

export { app, honoApp, server, io };
