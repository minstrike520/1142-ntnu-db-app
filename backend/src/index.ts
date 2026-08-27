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
const redis = createRedis();
const publisher = createRealtimePublisher();
const services = createServices({ repositories, publisher });
const honoApp = createHttpApp({ services, config });
const realtime = createRealtime({ config, repositories, publisher });
const server = createBunRuntimeServer({ app: honoApp, engine: realtime.engine });
const app = createHttpCompatibilityServer(honoApp);
const io = realtime.io;

/**
 * Outer bound on the shutdown drain, in milliseconds.
 *
 * Kept strictly between the drain's step-wise worst case (10s HTTP force-stop +
 * 2s presence + 2s Redis) and the 30s `stop_grace_period` that
 * docker-compose.prod.yml and docker-compose.release.yml set, so a drain that
 * hangs still exits on its own before the orchestrator resorts to SIGKILL.
 * Changing any of those three numbers means revisiting this one.
 */
const SHUTDOWN_DEADLINE_MS = 20_000;

if (require.main === module) {
  // Only the real entrypoint validates: importing the app (as the E2E suite
  // does) must not decide whether this environment is fit to serve traffic.
  try {
    assertStartupEnv();
  } catch (error) {
    if (!(error instanceof EnvConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }

  // Deliberately not awaited. Redis holds derived state only, so a Redis that
  // is slow or down must not delay or fail `server.listen` — the compose
  // healthcheck gates on this process answering HTTP, and letting a
  // presence/typing store decide whether the container becomes healthy would
  // take the whole API down over something every REST route works without.
  // `connect()` absorbs its own failures and leaves recovery to the manager's
  // watchdog, so there is nothing here to catch.
  void redis.connect();

  // Configured only in the real entrypoint, for the same reason as `startJobs`:
  // importing the app must not leave a heartbeat timer behind, and the E2E
  // suite has no Redis to share presence through anyway.
  const presence = createPresence({ config, redis });

  const stopJobs = startJobs({ repositories, services });
  void startServer({ server, config });
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopJobs();
    publisher.shutdown(signal);
    // Every step below is individually bounded — 10s to force the HTTP drain
    // (bootstrap/realtime.ts), 2s for presence, 2s for Redis — but the chain as a
    // whole was not: each bound is enforced by a timer, and the HTTP one is
    // `unref`'d, so a step that never settles strands the callbacks after it and
    // nothing here would ever call `process.exit`. This deadline is the outer
    // guarantee, and is the reason the container can promise it exits on its own
    // rather than waiting to be SIGKILLed. It sits above the ~14s step-wise worst
    // case and below the 30s `stop_grace_period` the compose files set, so the
    // process always wins the race against the orchestrator (issue #586).
    const deadline = setTimeout(() => {
      console.error('Shutdown deadline exceeded, exiting anyway', {
        signal,
        deadlineMs: SHUTDOWN_DEADLINE_MS,
      });
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS);
    // Redis is released last, inside the drain callback. `publisher.shutdown`
    // above disconnects every socket, which runs the disconnect handlers — and
    // those are the writes that release presence leases, so Redis has to still
    // be usable while the drain is in flight. `close()` is bounded and never
    // rejects, so an unreachable Redis cannot hold the deployment open.
    //
    // The `process.exit(0)` is required, not tidiness: a Bun Redis connection
    // that has dropped never releases its event-loop handle, even once closed
    // (see utils/redis.ts), so a process that lived through a Redis outage would
    // otherwise sit here after the drain until the orchestrator SIGKILLs it.
    server.close(() => {
      // Presence first: `stop()` hands back every lease this instance holds, so
      // a redeploy does not leave its users showing online for the rest of the
      // lease TTL. It needs Redis, which is why `redis.close()` waits for it.
      //
      // Postgres is deliberately not closed here. `Bun.SQL.close()` waits on
      // in-flight queries with no bound of its own, which would put an unbounded
      // step on the one path whose whole design property is being bounded — and
      // it would buy nothing: the pool holds no lease or advisory lock at steady
      // state, and `process.exit(0)` drops the sockets for Postgres to reap
      // immediately. Do not "complete" the drain by adding it.
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

export { app, honoApp, server, io, redis };
