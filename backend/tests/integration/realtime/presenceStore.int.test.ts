import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createRedisManager, type RedisManager } from '../../../src/utils/redis';
import {
  createRedisPresenceStore,
  presenceKey,
  type PresenceStore,
} from '../../../src/realtime/presenceStore';

/**
 * The Redis semantics the unit tier cannot honestly fake.
 *
 * `realtime/presenceStore.ts` leans on four promises that belong to the server,
 * not to this codebase: that `HPEXPIRE` expires one *field* rather than the
 * key, that `HLEN` does not count a field whose TTL has passed, that the key
 * disappears once its last field goes, and that a `Lua` script's read and write
 * are one atomic step. A `Map`-backed fake can be written to agree with all four
 * and still be wrong. This suite asks a real Redis instead.
 *
 * `REDIS_URL_TEST` defaults to the dev compose mapping, so `docker compose up -d
 * redis` from the repo root is enough to run it locally.
 */
const url = process.env.REDIS_URL_TEST || 'redis://localhost:6385';

// Namespaced per run so a leftover key from an interrupted run cannot make a
// later one pass or fail for the wrong reason, and so two runs can overlap.
const run = `it-${Math.random().toString(36).slice(2, 10)}`;
const user = (name: string): string => `${run}-${name}`;

describe('redis presence store against a real Redis', () => {
  let redis: RedisManager;
  let alpha: PresenceStore;
  let beta: PresenceStore;

  const ttlMs = 600;

  beforeAll(async () => {
    redis = createRedisManager({ url });
    await redis.connect();
    if (!(await redis.ping())) {
      throw new Error(
        `Redis is not reachable at ${url}. Start it with \`docker compose up -d redis\`, or set REDIS_URL_TEST.`,
      );
    }
    alpha = createRedisPresenceStore({ redis, instanceId: `${run}-alpha`, ttlMs });
    beta = createRedisPresenceStore({ redis, instanceId: `${run}-beta`, ttlMs });
  });

  afterAll(async () => {
    for (const name of ['solo', 'shared', 'expiring', 'page-a', 'page-b', 'listed']) {
      await redis.command('DEL', [presenceKey(user(name))]);
    }
    await redis.close();
  });

  beforeEach(async () => {
    for (const name of ['solo', 'shared', 'expiring', 'page-a', 'page-b', 'listed']) {
      await redis.command('DEL', [presenceKey(user(name))]);
    }
  });

  it('reports the first lease anywhere, and only the first', async () => {
    expect(await alpha.hold(user('shared'), 1)).toEqual({ ok: true, value: 0 });
    // A second instance is not a new arrival, and neither is a second tab.
    expect(await beta.hold(user('shared'), 1)).toEqual({ ok: true, value: 1 });
    expect(await alpha.hold(user('shared'), 2)).toEqual({ ok: true, value: 2 });
  });

  it('reports the last release anywhere, and only the last', async () => {
    await alpha.hold(user('shared'), 1);
    await beta.hold(user('shared'), 1);

    expect(await alpha.release(user('shared'))).toEqual({ ok: true, value: 1 });
    expect(await alpha.isOnline(user('shared'))).toEqual({ ok: true, value: true });

    expect(await beta.release(user('shared'))).toEqual({ ok: true, value: 0 });
    expect(await alpha.isOnline(user('shared'))).toEqual({ ok: true, value: false });
  });

  it('deletes the key once the last lease is handed back', async () => {
    await alpha.hold(user('solo'), 1);
    await alpha.release(user('solo'));

    expect(await redis.command('EXISTS', [presenceKey(user('solo'))])).toEqual({
      ok: true,
      value: 0,
    });
  });

  it('lets an unrefreshed lease expire on its own, which is what bounds a crashed instance', async () => {
    await alpha.hold(user('expiring'), 1);
    expect(await beta.isOnline(user('expiring'))).toEqual({ ok: true, value: true });

    // Nothing refreshes it — the instance that took it is gone.
    await new Promise((resolve) => setTimeout(resolve, ttlMs + 300));

    expect(await beta.isOnline(user('expiring'))).toEqual({ ok: true, value: false });
    expect(await redis.command('EXISTS', [presenceKey(user('expiring'))])).toEqual({
      ok: true,
      value: 0,
    });
  });

  it('expires one instance lease without touching another', async () => {
    await alpha.hold(user('shared'), 1);
    await new Promise((resolve) => setTimeout(resolve, ttlMs / 2));
    // beta arrives halfway through alpha's lease and keeps refreshing.
    await beta.hold(user('shared'), 1);
    await new Promise((resolve) => setTimeout(resolve, ttlMs / 2 + 200));

    // alpha's field is gone; beta's is not, so the user is still online.
    expect(await alpha.isOnline(user('shared'))).toEqual({ ok: true, value: true });
    expect(await redis.command('HLEN', [presenceKey(user('shared'))])).toEqual({
      ok: true,
      value: 1,
    });
  });

  it('a refresh keeps a live lease past the TTL', async () => {
    await alpha.hold(user('expiring'), 1);
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, ttlMs / 3));
      await alpha.hold(user('expiring'), 1);
    }
    await new Promise((resolve) => setTimeout(resolve, ttlMs / 2));

    expect(await beta.isOnline(user('expiring'))).toEqual({ ok: true, value: true });
  });

  describe('a server that cannot expire a hash field', () => {
    // Redis older than 7.4 has no `HPEXPIRE`, and this module's documented
    // answer is to degrade to single-node. That answer is only honest if the
    // failed attempt leaves nothing behind — the two tests below are why the
    // hold script traps the failure instead of letting it abort.
    //
    // `HPEXPIRE` cannot be made unknown on this server, so the *shape* is
    // reproduced with a command name that never exists. What is being pinned is
    // Redis's behaviour, not this module's source: that a script is atomic but
    // not transactional, and that `redis.pcall` can trap an unknown command.
    const UNGUARDED = `
local before = redis.call('HLEN', KEYS[1])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('HPEXPIRE_THAT_DOES_NOT_EXIST', KEYS[1], ARGV[2], 'FIELDS', 1, ARGV[1])
return before
`.trim();

    const GUARDED = `
local before = redis.call('HLEN', KEYS[1])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
local expiry = redis.pcall('HPEXPIRE_THAT_DOES_NOT_EXIST', KEYS[1], ARGV[2], 'FIELDS', 1, ARGV[1])
if type(expiry) == 'table' and expiry.err then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return expiry
end
return before
`.trim();

    const evalHold = (script: string, name: string) =>
      redis.command('EVAL', [script, '1', presenceKey(user(name)), `${run}-alpha`, '600', '1']);

    it('leaves an immortal lease behind without the guard, which is the bug', async () => {
      const result = await evalHold(UNGUARDED, 'solo');

      expect(result.ok).toBe(false);
      // The write that ran before the error is still there, and with no TTL —
      // so the instance that took it could die and the user would read online
      // for good.
      expect(await redis.command('HLEN', [presenceKey(user('solo'))])).toEqual({
        ok: true,
        value: 1,
      });
      expect(
        await redis.command('HPTTL', [presenceKey(user('solo')), 'FIELDS', '1', `${run}-alpha`]),
      ).toEqual({ ok: true, value: [-1] });
    });

    it('leaves no trace with the guard, and still reports the failure', async () => {
      const result = await evalHold(GUARDED, 'solo');

      expect(result.ok).toBe(false);
      expect(await redis.command('EXISTS', [presenceKey(user('solo'))])).toEqual({
        ok: true,
        value: 0,
      });
    });

    it('rolls back only its own field, not another instance that is holding one', async () => {
      await beta.hold(user('shared'), 1);

      const result = await evalHold(GUARDED, 'shared');

      expect(result.ok).toBe(false);
      expect(await alpha.isOnline(user('shared'))).toEqual({ ok: true, value: true });
      expect(await redis.command('HLEN', [presenceKey(user('shared'))])).toEqual({
        ok: true,
        value: 1,
      });
    });
  });

  it('resolves a page of users in one round trip', async () => {
    await alpha.hold(user('page-a'), 1);

    const result = await beta.areOnline([user('page-a'), user('page-b')]);

    expect(result.ok).toBe(true);
    expect(result.ok && [...result.value]).toEqual([user('page-a')]);
  });

  it('lists every user any instance holds a lease on', async () => {
    await alpha.hold(user('listed'), 1);

    const result = await beta.onlineUsers();

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toContain(user('listed'));
  });
});
