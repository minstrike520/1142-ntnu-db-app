import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createRedisManager, type RedisManager } from '../../../src/utils/redis';
import { createRedisTypingStore, typingKey, type TypingStore } from '../../../src/realtime/typingStore';

/**
 * The Redis semantics the unit tier cannot honestly fake.
 *
 * `realtime/typingStore.ts` rests on the same server promises the presence
 * store does — that `HPEXPIRE` expires one *field* rather than the key, that
 * `HLEN` stops counting a field whose TTL has passed, that the key disappears
 * with its last field, and that a Lua script's read and write are one step —
 * and one that matters more here than it does there: that the `HDEL` and the
 * `HLEN` deciding who retracts are atomic, because whichever instance sees zero
 * is the one that tells the room the user stopped. A `Map`-backed fake can be
 * written to agree with all of it and still be wrong.
 *
 * `REDIS_URL_TEST` defaults to the dev compose mapping, so `docker compose up -d
 * redis` from the repo root is enough to run it locally.
 */
const url = process.env.REDIS_URL_TEST || 'redis://localhost:6385';

// Namespaced per run so a leftover key from an interrupted run cannot make a
// later one pass or fail for the wrong reason, and so two runs can overlap.
const run = `it-${Math.random().toString(36).slice(2, 10)}`;
const room = (name: string): string => `${run}-${name}`;
const USER = 'user-1';
const ROOMS = ['shared', 'solo', 'expiring', 'refreshed'];

describe('redis typing store against a real Redis', () => {
  let redis: RedisManager;
  let alpha: TypingStore;
  let beta: TypingStore;

  const ttlMs = 600;

  beforeAll(async () => {
    redis = createRedisManager({ url });
    await redis.connect();
    if (!(await redis.ping())) {
      throw new Error(
        `Redis is not reachable at ${url}. Start it with \`docker compose up -d redis\`, or set REDIS_URL_TEST.`,
      );
    }
    alpha = createRedisTypingStore({ redis, instanceId: `${run}-alpha`, ttlMs });
    beta = createRedisTypingStore({ redis, instanceId: `${run}-beta`, ttlMs });
  });

  afterAll(async () => {
    for (const name of ROOMS) await redis.command('DEL', [typingKey(room(name), USER)]);
    await redis.close();
  });

  beforeEach(async () => {
    for (const name of ROOMS) await redis.command('DEL', [typingKey(room(name), USER)]);
  });

  it('keeps two instances claims for the same room member side by side', async () => {
    await alpha.claim(room('shared'), USER);
    await beta.claim(room('shared'), USER);

    expect(await redis.command('HLEN', [typingKey(room('shared'), USER)])).toEqual({
      ok: true,
      value: 2,
    });
  });

  it('reports the last release anywhere, and only the last', async () => {
    await alpha.claim(room('shared'), USER);
    await beta.claim(room('shared'), USER);

    // The first instance to stop is not the one that tells the room.
    expect(await alpha.release(room('shared'), USER)).toEqual({ ok: true, value: 1 });
    expect(await beta.release(room('shared'), USER)).toEqual({ ok: true, value: 0 });
  });

  it('refreshes rather than duplicates a claim the same instance already holds', async () => {
    await alpha.claim(room('solo'), USER);
    await alpha.claim(room('solo'), USER);

    expect(await alpha.release(room('solo'), USER)).toEqual({ ok: true, value: 0 });
  });

  it('deletes the key once the last claim is handed back', async () => {
    await alpha.claim(room('solo'), USER);
    await alpha.release(room('solo'), USER);

    expect(await redis.command('EXISTS', [typingKey(room('solo'), USER)])).toEqual({
      ok: true,
      value: 0,
    });
  });

  it('lets an unrefreshed claim expire, which is what bounds a crashed instance', async () => {
    await alpha.claim(room('expiring'), USER);

    // Nothing refreshes it — the instance that took it is gone. Without this
    // the leftover field would suppress every later retraction for this room
    // member, because no one would ever see the count reach zero.
    await new Promise((resolve) => setTimeout(resolve, ttlMs + 300));

    expect(await beta.release(room('expiring'), USER)).toEqual({ ok: true, value: 0 });
  });

  it('expires one instance claim without touching another', async () => {
    await alpha.claim(room('shared'), USER);
    await new Promise((resolve) => setTimeout(resolve, ttlMs / 2));
    // beta starts typing halfway through alpha's claim and keeps refreshing.
    await beta.claim(room('shared'), USER);
    await new Promise((resolve) => setTimeout(resolve, ttlMs / 2 + 200));

    expect(await redis.command('HLEN', [typingKey(room('shared'), USER)])).toEqual({
      ok: true,
      value: 1,
    });
  });

  it('a refresh keeps a live claim past the TTL', async () => {
    await alpha.claim(room('refreshed'), USER);
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, ttlMs / 3));
      await alpha.claim(room('refreshed'), USER);
    }
    await new Promise((resolve) => setTimeout(resolve, ttlMs / 2));

    // beta is not the last holder, so it stays silent and alpha keeps the room.
    expect(await beta.release(room('refreshed'), USER)).toEqual({ ok: true, value: 1 });
  });

  it('separates one room member from another under the same user', async () => {
    await alpha.claim(room('shared'), USER);

    expect(await alpha.release(room('solo'), USER)).toEqual({ ok: true, value: 0 });
    expect(await redis.command('HLEN', [typingKey(room('shared'), USER)])).toEqual({
      ok: true,
      value: 1,
    });
  });
});
