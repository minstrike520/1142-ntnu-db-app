import type { AppConfig } from './config';
import type { RedisManager } from '../utils/redis';
import { env } from '../config/env';
import { configurePresence, type PresenceTracker } from '../realtime/presence';
import { createRedisPresenceStore } from '../realtime/presenceStore';

export interface CreatePresenceDeps {
  config: AppConfig;
  redis: RedisManager;
}

/**
 * The presence assembly stage.
 *
 * Thin like the other bootstrap factories: it decides *whether* presence is
 * shared, and hands `realtime/presence.ts` the store to share it through.
 *
 * No `REDIS_URL` means no store at all, rather than a store over a manager that
 * will refuse every command. The manager is happy to be asked either way, but a
 * store would mean a heartbeat timer refreshing leases that were never taken
 * and a warning about a Redis nobody asked for — so a deployment that has opted
 * out of Redis keeps exactly the single-node presence it had before Redis
 * existed, timers included.
 */
export const createPresence = ({ config, redis }: CreatePresenceDeps): PresenceTracker => {
  const { redisUrl, realtime } = env();
  if (!redisUrl) return configurePresence({});

  return configurePresence({
    store: createRedisPresenceStore({
      redis,
      instanceId: config.instanceId,
      ttlMs: realtime.presenceTtlMs,
    }),
    ttlMs: realtime.presenceTtlMs,
  });
};
