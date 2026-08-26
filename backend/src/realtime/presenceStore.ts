import type pino from 'pino';
import type { RedisManager, RedisOutcome } from '../utils/redis';
import { DEFAULT_PRESENCE_TTL_MS } from '../config/env';
import { logger as defaultLogger } from '../utils/logger';

/**
 * Namespace for every presence key.
 *
 * One Redis serves presence, typing and pub/sub for this stack, so each feature
 * owns a prefix and `onlineUsers()` can scan for its own keys without seeing
 * anyone else's.
 */
export const PRESENCE_KEY_PREFIX = 'presence:user:';

export const presenceKey = (userId: string): string => `${PRESENCE_KEY_PREFIX}${userId}`;

/**
 * Cross-instance presence, as leases rather than as a live connection list.
 *
 * The shape is one hash per user, one field per backend instance, and a TTL on
 * each *field*:
 *
 * ```
 * presence:user:{userId}  ->  { "{instanceId}": "{connections}" }   each field PEXPIREd
 * ```
 *
 * Per-field TTLs (Redis 7.4+) rather than a TTL on the whole key, because the
 * key belongs to the user and the lease belongs to the instance: with one
 * expiry for the whole hash, the busiest instance's refresh would keep a
 * crashed instance's row alive forever. Per field, a process that dies stops
 * refreshing only its own row, and Redis drops it — then drops the key once the
 * last row is gone, which is what makes "no key" and "nobody online" the same
 * state.
 *
 * Per *instance* rather than per socket, because no other instance has any use
 * for how many tabs someone has open here. The socket-level bookkeeping stays
 * local, where it is already needed for the reconnect grace period, and the
 * only thing that crosses the network is the one bit that is genuinely shared:
 * this instance has at least one live connection for this user.
 *
 * Redis owns the clock throughout. Expiry is evaluated by the server against
 * the TTL it was handed, never by comparing a stored timestamp against a
 * reader's `Date.now()`, so two instances whose clocks disagree still agree on
 * who is online.
 */
export interface PresenceStore {
  /**
   * Take or refresh this instance's lease on a user.
   *
   * Resolves to how many instances held a lease *before* this call, so `0`
   * means this connection is the first one anywhere — which is exactly the
   * edge that broadcasts `online`. Idempotent, and the heartbeat calls it too.
   */
  hold(userId: string, connections: number): Promise<RedisOutcome<number>>;
  /**
   * Drop this instance's lease on a user.
   *
   * Resolves to how many instances still hold one, so `0` means the user has
   * gone offline everywhere — the edge that broadcasts `offline`.
   */
  release(userId: string): Promise<RedisOutcome<number>>;
  /** Whether any instance holds a lease on this user. */
  isOnline(userId: string): Promise<RedisOutcome<boolean>>;
  /**
   * The subset of these users any instance holds a lease on.
   *
   * A batch rather than a loop of `isOnline`, because the callers that ask this
   * question ask it about a whole page at once — every private room in
   * `GET /rooms`, every friend in `GET /friends` — and a per-user call there
   * puts the size of someone's contact list into the shape of the endpoint.
   */
  areOnline(userIds: string[]): Promise<RedisOutcome<Set<string>>>;
  /** Every user any instance holds a lease on. Diagnostic; see the note on the scan. */
  onlineUsers(): Promise<RedisOutcome<string[]>>;
}

/**
 * Take the lease and report the previous holder count, in one round trip.
 *
 * A script rather than three commands, for two reasons that are both
 * correctness rather than latency. `HSET` clears a field's TTL, so a process
 * that died between the `HSET` and the `HPEXPIRE` would leave a lease with no
 * expiry at all — a user online forever, which is the one failure the TTL
 * exists to prevent. And reading `HLEN` separately from the write makes the
 * "first connection anywhere" test a race: two instances taking a user's first
 * lease at the same moment would both read a count that already included the
 * other, and neither would announce the user online.
 *
 * `redis.pcall` and the compensating `HDEL` are what make the *script* safe to
 * run against a server that cannot do the second half. A script is atomic but
 * it is not transactional: an error partway through does not roll back what ran
 * before it, so on a Redis older than 7.4 the `HSET` would land, `HPEXPIRE`
 * would fail as an unknown command, and the degraded mode this module documents
 * would leave behind exactly the immortal lease it is trying to avoid —
 * verified against a real server, and pinned in
 * `tests/integration/realtime/presenceStore.int.test.ts`. Trapping the failure
 * and undoing the write inside the same script means the operation either takes
 * an expiring lease or leaves no trace, with no version probe to race and no
 * state to keep. Returning the error table propagates it as an error reply, so
 * the caller still sees `{ ok: false }` and degrades to this instance only.
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

/**
 * Drop the lease and report who is left, in one round trip.
 *
 * Same reasoning as `HOLD_SCRIPT` in the other direction: read the remaining
 * count separately and two instances releasing at once can both see the other's
 * row still present, so neither announces the user offline and the last
 * transition is lost. Redis deletes the hash when its final field goes, so an
 * empty result and a missing key are the same answer.
 */
const RELEASE_SCRIPT = `
redis.call('HDEL', KEYS[1], ARGV[1])
return redis.call('HLEN', KEYS[1])
`.trim();

/**
 * How many instances hold a lease on each of these users, in one round trip.
 *
 * Multi-key, which a Redis Cluster would reject for keys in different slots.
 * That is a deliberate limit rather than an oversight: nothing else in this
 * stack is cluster-aware — `utils/redis.ts` drives one client against one
 * endpoint — and the moment a cluster is on the table this call becomes a
 * chunked fan-out, not a rewrite of the key schema.
 */
const ONLINE_AMONG_SCRIPT = `
local out = {}
for i = 1, #KEYS do out[i] = redis.call('HLEN', KEYS[i]) end
return out
`.trim();

/** Redis integer replies arrive as numbers, but a fake or a proxy may stringify them. */
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
      // `HLEN` and not `EXISTS`: Redis reports a hash whose fields have all
      // expired as length zero even in the window before the key itself is
      // collected, so this answers "is anyone holding a lease" rather than "was
      // there a key here recently".
      const result = await redis.command('HLEN', [presenceKey(userId)]);
      if (!result.ok) return result;
      return { ok: true as const, value: asCount(result.value) > 0 };
    },

    async areOnline(userIds) {
      const unique = [...new Set(userIds)];
      // Not an empty-result shortcut for its own sake: `EVAL` with a numkeys of
      // zero is a different command shape, and every caller here can legitimately
      // hand over an empty page.
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
      // Deliberately a scan, and deliberately not on a request path. There is no
      // index of online users to read instead, and maintaining one would mean a
      // second write per connect that a crashed instance would never undo —
      // reintroducing exactly the stale state the leases exist to avoid. The
      // cost is paid only by diagnostics and tests, which is where the callers
      // are; `isOnline` is the one that answers per-user questions.
      const users: string[] = [];
      let cursor = '0';
      // A cursor that never returns to '0' would spin forever. Redis guarantees
      // termination, but a fake or a proxy is not Redis.
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
          // A key whose every field has expired is still returned by `SCAN`
          // until Redis collects it, so each candidate is confirmed rather than
          // trusted.
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
