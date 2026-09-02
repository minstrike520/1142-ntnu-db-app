import db from './models/db';
import { assertStartupEnv, EnvConfigError } from './config/env';
import { createConfig } from './bootstrap/config';
import { createRepositories } from './bootstrap/repositories';
import { createServices } from './bootstrap/services';
import { createHttpApp } from './bootstrap/httpApp';
import { createRedis } from './bootstrap/redis';
import { createPresence } from './bootstrap/presence';
import { createBunRuntimeServer, createRealtime } from './bootstrap/realtime';
import { createRealtimePublisher } from './realtime/publisher';
import { startJobs } from './bootstrap/jobs';
import { startServer } from './bootstrap/start';

/**
 * Main application composition root.
 * Integrates Hono HTTP routing and Socket.IO realtime server on Bun.
 */
const config = createConfig();
const repositories = createRepositories(db);
const redis = createRedis();
const publisher = createRealtimePublisher();
const services = createServices({ repositories, publisher });
const honoApp = createHttpApp({ services, config });
const realtime = createRealtime({ config, repositories, publisher, redis });
const server = createBunRuntimeServer({ app: honoApp, engine: realtime.engine });
const io = realtime.io;

// Maximum duration (in ms) to wait for graceful shutdown before forcing exit.
const SHUTDOWN_DEADLINE_MS = 20_000;

if (require.main === module) {
  try {
    assertStartupEnv();
  } catch (error) {
    if (!(error instanceof EnvConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }

  // Connect to Redis asynchronously in background without blocking HTTP startup.
  void redis.connect();

  const presence = createPresence({ config, redis });
  const stopJobs = startJobs({ repositories, services });
  void startServer({ server, config });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopJobs();
    publisher.shutdown(signal);

    // Hard fallback timer to ensure process terminates within deadline.
    const deadline = setTimeout(() => {
      console.error('Shutdown deadline exceeded, exiting anyway', {
        signal,
        deadlineMs: SHUTDOWN_DEADLINE_MS,
      });
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS);

    // Drain HTTP server, release presence leases, and disconnect Redis.
    server.close(() => {
      void presence.stop().finally(() =>
        redis.close().finally(() => {
          clearTimeout(deadline);
          process.exit(0);
        }),
      );
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

export { honoApp, server, io, redis };
