import type pino from 'pino';
import type { RedisManager, RedisOutcome } from '../utils/redis';
import { DEFAULT_TYPING_TTL_MS } from '../config/env';
import { logger as defaultLogger } from '../utils/logger';

/** Redis key prefix for typing claims: typing:room:{roomId}:user:{userId} */
export const TYPING_KEY_PREFIX = 'typing:room:';

export const typingKey = (roomId: string, userId: string): string =>
  `${TYPING_KEY_PREFIX}${roomId}:user:${userId}`;

/**
 * Cross-instance typing claims as per-instance leases in Redis.
 * Key schema: typing:room:{roomId}:user:{userId} -> { "{instanceId}": "1" }
 *
 * The field value carries no information — a claim either exists or it does
 * not. `socketServer.ts` already collapses a user's sockets on one instance
 * into a single claim, so a per-instance count would only add a decrement that
 * can drift out of step with that local set, leaving a field that never reaches
 * zero until its TTL. Existence corrects itself on the next write.
 */
export interface TypingStore {
  /** Takes or refreshes this instance's claim on a user typing in a room. */
  claim(roomId: string, userId: string): Promise<RedisOutcome<void>>;
  /** Drops this instance's claim; returns how many instances still hold one. */
  release(roomId: string, userId: string): Promise<RedisOutcome<number>>;
}

/**
 * Lua script: Sets instance field with TTL using HPEXPIRE.
 * Rolls back if HPEXPIRE fails, so a claim is never left immortal.
 */
const CLAIM_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], '1')
local expiry = redis.pcall('HPEXPIRE', KEYS[1], ARGV[2], 'FIELDS', 1, ARGV[1])
if type(expiry) == 'table' and expiry.err then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return expiry
end
return 1
`.trim();

/** Lua script: Deletes instance field and returns remaining holder count. */
const RELEASE_SCRIPT = `
redis.call('HDEL', KEYS[1], ARGV[1])
return redis.call('HLEN', KEYS[1])
`.trim();

/** Coerces Redis reply values into a non-negative count. */
const asCount = (value: unknown): number => {
  const count = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
};

export interface CreateTypingStoreOptions {
  redis: RedisManager;
  /** This process's identity; one hash field per instance. See `AppConfig`. */
  instanceId: string;
  /**
   * How long a claim survives unrefreshed.
   *
   * The same `TYPING_TTL_MS` the local expiry timer uses, deliberately: a
   * longer lease would outlive the local claim it stands for, and every extra
   * millisecond is time a crashed instance's leftover field suppresses a
   * retraction that another instance is entitled to make.
   */
  ttlMs: number;
  logger?: pino.Logger;
}

export const createRedisTypingStore = ({
  redis,
  instanceId,
  ttlMs,
  logger = defaultLogger,
}: CreateTypingStoreOptions): TypingStore => {
  // Sanitised for the same reason as the presence store's: a non-finite value
  // would reach Redis as the literal `NaN` and come back as an unsupported
  // server rather than a bad setting.
  const ttl = String(Number.isFinite(ttlMs) ? Math.max(1, Math.trunc(ttlMs)) : DEFAULT_TYPING_TTL_MS);
  // Hash-field TTLs need Redis 7.4+, and the error says only "unknown command".
  // Warned once for the same reason presence warns once: a down or too-old
  // Redis produces one failure per keystroke, and the recent-log buffer holds
  // 200 records in total.
  let warned = false;
  const warnUnsupported = (operation: string, error: Error): void => {
    if (warned) return;
    warned = true;
    logger.warn(
      { operation, error: error.message, instanceId },
      'Typing claims are not reaching Redis; typing falls back to this instance only. Cross-instance typing needs Redis 7.4 or newer for hash-field TTLs',
    );
  };

  return {
    async claim(roomId, userId) {
      const result = await redis.command('EVAL', [
        CLAIM_SCRIPT,
        '1',
        typingKey(roomId, userId),
        instanceId,
        ttl,
      ]);
      if (!result.ok) {
        warnUnsupported('claim', result.error);
        return result;
      }
      return { ok: true as const, value: undefined };
    },

    async release(roomId, userId) {
      const result = await redis.command('EVAL', [
        RELEASE_SCRIPT,
        '1',
        typingKey(roomId, userId),
        instanceId,
      ]);
      if (!result.ok) {
        warnUnsupported('release', result.error);
        return result;
      }
      return { ok: true as const, value: asCount(result.value) };
    },
  };
};
