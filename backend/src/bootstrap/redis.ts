import { env } from '../config/env';
import { createRedisManager, type RedisManager } from '../utils/redis';

/**
 * The Redis assembly stage.
 *
 * Thin by design, like the other bootstrap factories: it reads the resolved
 * configuration and hands `utils/redis.ts` its URL, so nothing under `utils/`
 * has to know where configuration comes from and nothing under `realtime/` or
 * `services/` has to know Redis exists as a URL at all.
 *
 * Constructing a manager opens no socket — `connect()` does, and the
 * composition root calls it only in the real entrypoint. That keeps importing
 * the app (which the E2E suite does) free of any connection attempt, the same
 * property `models/db.ts` maintains for PostgreSQL.
 */
export const createRedis = (): RedisManager => createRedisManager({ url: env().redisUrl });
