import type pino from 'pino';
import type { RedisManager, RedisOutcome } from '../utils/redis';
import { DEFAULT_PRESENCE_TTL_MS } from '../config/env';
import { logger as defaultLogger } from '../utils/logger';

/** Redis key prefix for presence hashes: presence:user:{userId} */
export const PRESENCE_KEY_PREFIX = 'presence:user:';

export const presenceKey = (userId: string): string => `${PRESENCE_KEY_PREFIX}${userId}`;

/**
 * Distributed presence store using Redis hash-field TTLs (Redis 7.4+).
 * Key schema: presence:user:{userId} -> { "{instanceId}": "{connectionCount}" }
 */
export interface PresenceStore {
  /** Holds or refreshes a lease for a user; returns previous holder count. */
  hold(userId: string, connections: number): Promise<RedisOutcome<number>>;
  /** Releases a lease for a user; returns remaining holder count. */
  release(userId: string): Promise<RedisOutcome<number>>;
  /** Checks if any instance holds a lease on this user. */
  isOnline(userId: string): Promise<RedisOutcome<boolean>>;
  /** Checks online status for multiple users in a single round trip. */
  areOnline(userIds: string[]): Promise<RedisOutcome<Set<string>>>;
  /** Returns all currently online users (diagnostic/admin). */
  onlineUsers(): Promise<RedisOutcome<string[]>>;
}

/**
 * Lua script: Sets instance field with TTL using HPEXPIRE.
 * Returns the holder count before the write. Rolls back if HPEXPIRE fails.
 */
const HOLD_SCRIPT = `
local before = redis.call('HLEN', KEYS[1])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
local expiry = redis.pcall('HPEXPIRE', KEYS[1], ARGV[2], 'FIELDS', 1, ARGV[1])
if type(expiry) == 'table' and expiry.err then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return expiry
end
return before
`.trim();

/** Lua script: Deletes instance field and returns remaining holder count. */
const RELEASE_SCRIPT = `
redis.call('HDEL', KEYS[1], ARGV[1])
return redis.call('HLEN', KEYS[1])
`.trim();

/** Lua script: Queries holder counts for multiple user keys in one call. */
const ONLINE_AMONG_SCRIPT = `
local out = {}
for i = 1, #KEYS do out[i] = redis.call('HLEN', KEYS[i]) end
return out
`.trim();

/** Coerces Redis reply values into a non-negative count. */
const asCount = (value: unknown): number => {
  const count = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
};

export interface CreatePresenceStoreOptions {
  redis: RedisManager;
  /** This process's identity; one hash field per instance. See `AppConfig`. */
  instanceId: string;
  /** How long a lease survives unrefreshed. */
  ttlMs: number;
  logger?: pino.Logger;
}

export const createRedisPresenceStore = ({
  redis,
  instanceId,
  ttlMs,
  logger = defaultLogger,
}: CreatePresenceStoreOptions): PresenceStore => {
  // Sanitised rather than trusted: a non-finite value would reach Redis as the
  // literal `NaN` and be rejected there, which the guard in `HOLD_SCRIPT` would
  // then handle as an unsupported server — a confusing way to report a bad
  // setting. `config/env.ts` already rejects an unparsable `PRESENCE_TTL_MS`,
  // so this only covers a caller constructing the store directly.
  const ttl = String(Number.isFinite(ttlMs) ? Math.max(1, Math.trunc(ttlMs)) : DEFAULT_PRESENCE_TTL_MS);
  // Hash-field TTLs are the one thing here that a Redis older than 7.4 does not
  // have, and its error says only "unknown command". Naming the requirement
  // once turns a silently single-node deployment into a fixable one, and once
  // is the limit because a down Redis produces one failure per connected user
  // per heartbeat and the recent-log buffer holds 200 records in total.
  let warned = false;
  const warnUnsupported = (operation: string, error: Error): void => {
    if (warned) return;
    warned = true;
    logger.warn(
      { operation, error: error.message, instanceId },
      'Presence leases are not reaching Redis; presence falls back to this instance only. Cross-instance presence needs Redis 7.4 or newer for hash-field TTLs',
    );
  };

  return {
    async hold(userId, connections) {
      const result = await redis.command('EVAL', [
        HOLD_SCRIPT,
        '1',
        presenceKey(userId),
        instanceId,
        ttl,
        String(connections),
      ]);
      if (!result.ok) {
        warnUnsupported('hold', result.error);
        return result;
      }
      return { ok: true as const, value: asCount(result.value) };
    },

    async release(userId) {
      const result = await redis.command('EVAL', [
        RELEASE_SCRIPT,
        '1',
        presenceKey(userId),
        instanceId,
      ]);
      if (!result.ok) {
        warnUnsupported('release', result.error);
        return result;
      }
      return { ok: true as const, value: asCount(result.value) };
    },

    async isOnline(userId) {
      // HLEN > 0 indicates at least one active instance holds an unexpired lease.
      const result = await redis.command('HLEN', [presenceKey(userId)]);
      if (!result.ok) return result;
      return { ok: true as const, value: asCount(result.value) > 0 };
    },

    async areOnline(userIds) {
      const unique = [...new Set(userIds)];
      if (unique.length === 0) return { ok: true as const, value: new Set<string>() };

      const result = await redis.command<unknown>('EVAL', [
        ONLINE_AMONG_SCRIPT,
        String(unique.length),
        ...unique.map(presenceKey),
      ]);
      if (!result.ok) return result as RedisOutcome<never>;

      const counts = Array.isArray(result.value) ? result.value : [];
      const online = new Set<string>();
      unique.forEach((userId, index) => {
        if (asCount(counts[index]) > 0) online.add(userId);
      });
      return { ok: true as const, value: online };
    },

    async onlineUsers() {
      // Scans for active presence keys (used for admin/diagnostics).
      const users: string[] = [];
      let cursor = '0';
      for (let page = 0; page < 10_000; page += 1) {
        const scan = await redis.command<unknown>('SCAN', [
          cursor,
          'MATCH',
          `${PRESENCE_KEY_PREFIX}*`,
          'COUNT',
          '200',
        ]);
        if (!scan.ok) return scan as RedisOutcome<never>;

        const page1 = Array.isArray(scan.value) ? scan.value : [];
        const next = page1[0];
        const keys = Array.isArray(page1[1]) ? (page1[1] as unknown[]) : [];
        for (const key of keys) {
          const name = String(key);
          if (!name.startsWith(PRESENCE_KEY_PREFIX)) continue;
          const userId = name.slice(PRESENCE_KEY_PREFIX.length);
          const live = await redis.command('HLEN', [name]);
          if (live.ok && asCount(live.value) > 0) users.push(userId);
        }

        cursor = next === undefined || next === null ? '0' : String(next);
        if (cursor === '0') break;
      }
      return { ok: true as const, value: [...new Set(users)] };
    },
  };
};
