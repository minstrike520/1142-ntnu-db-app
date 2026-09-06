import { describe, it, expect } from 'bun:test';
import pino from 'pino';
import {
  createRedisTypingStore,
  typingKey,
  TYPING_KEY_PREFIX,
} from '../../../src/realtime/typingStore';
import type { RedisManager, RedisOutcome } from '../../../src/utils/redis';

interface RecordedCommand {
  command: string;
  args: string[];
}

/**
 * A `RedisManager` that records what it was asked and answers from a script.
 *
 * The same recorder the presence store's unit tier uses, and for the same
 * reason: what this tier can honestly check is the *protocol* — which command,
 * which key, which arguments, and how a reply is mapped back. Whether
 * `HPEXPIRE` really expires one field, and whether `HLEN` really stops counting
 * it afterwards, are Redis's promises and are pinned against a real server in
 * `tests/integration/realtime/typingStore.int.test.ts`.
 */
const makeRedis = (replies: unknown[] | ((call: RecordedCommand) => unknown)) => {
  const calls: RecordedCommand[] = [];
  let index = 0;
  const redis = {
    async command<T>(command: string, args: string[] = []): Promise<RedisOutcome<T>> {
      const call = { command, args };
      calls.push(call);
      const reply = typeof replies === 'function' ? replies(call) : replies[index++];
      if (reply instanceof Error) return { ok: false, error: reply };
      return { ok: true, value: reply as T };
    },
  } as unknown as RedisManager;
  return { redis, calls };
};

const makeStore = (redis: RedisManager, logger?: pino.Logger) =>
  createRedisTypingStore({ redis, instanceId: 'alpha', ttlMs: 3_000, logger });

describe('redis typing store', () => {
  it('keys a claim by room and user, and names this instance as the holder', async () => {
    const { redis, calls } = makeRedis([1]);
    const store = makeStore(redis);

    expect(await store.claim('room-1', 'user-1')).toEqual({ ok: true, value: undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('EVAL');
    const [script, numkeys, key, instanceId, ttl] = calls[0].args;
    expect(numkeys).toBe('1');
    expect(key).toBe(`${TYPING_KEY_PREFIX}room-1:user:user-1`);
    expect(instanceId).toBe('alpha');
    expect(ttl).toBe('3000');
    expect(script).toContain('HSET');
    expect(script).toContain('HPEXPIRE');
    // A script is atomic but not transactional: an `HPEXPIRE` that fails on an
    // older server would otherwise leave the `HSET` behind as a claim that
    // never expires, and a claim that never expires suppresses every later
    // retraction for that room member.
    expect(script).toContain('redis.pcall');
    expect(script).toContain('HDEL');
  });

  it('separates one room member from another', async () => {
    expect(typingKey('room-1', 'user-1')).not.toBe(typingKey('room-1', 'user-2'));
    expect(typingKey('room-1', 'user-1')).not.toBe(typingKey('room-2', 'user-1'));
  });

  it('stores no count in the field, only that the claim exists', async () => {
    const { redis, calls } = makeRedis([1]);
    await makeStore(redis).claim('room-1', 'user-1');

    // Anything else would need decrement semantics that can drift out of step
    // with the local socket set; see the comment on `TypingStore`.
    expect(calls[0].args[0]).toContain("'1'");
    expect(calls[0].args).toHaveLength(5);
  });

  it('drops the claim and reports how many instances are left', async () => {
    const { redis, calls } = makeRedis([1]);
    const store = makeStore(redis);

    expect(await store.release('room-1', 'user-1')).toEqual({ ok: true, value: 1 });
    expect(calls[0].command).toBe('EVAL');
    expect(calls[0].args[2]).toBe(typingKey('room-1', 'user-1'));
    expect(calls[0].args[3]).toBe('alpha');
    expect(calls[0].args[0]).toContain('HDEL');
    expect(calls[0].args[0]).toContain('HLEN');
  });

  it('reports nobody left once the last instance releases', async () => {
    const { redis } = makeRedis([0]);
    expect(await makeStore(redis).release('room-1', 'user-1')).toEqual({ ok: true, value: 0 });
  });

  it('reads a non-numeric reply as nobody left rather than as a holder', async () => {
    const { redis } = makeRedis([null]);
    expect(await makeStore(redis).release('room-1', 'user-1')).toEqual({ ok: true, value: 0 });
  });

  it('reports a failed command rather than inventing a holder count', async () => {
    const { redis } = makeRedis(() => new Error('ERR unknown command HPEXPIRE'));
    const result = await makeStore(redis).release('room-1', 'user-1');

    // `socketServer.ts` retracts on `!ok`, so a store that answered `1` here
    // would strand the indicator instead of degrading to single-node behaviour.
    expect(result.ok).toBe(false);
  });

  it('names the Redis version requirement once, not once per keystroke', async () => {
    const lines: string[] = [];
    const logger = pino(
      { level: 'warn' },
      { write: (line: string) => lines.push(line) } as pino.DestinationStream,
    );
    const { redis } = makeRedis(() => new Error('ERR unknown command HPEXPIRE'));
    const store = makeStore(redis, logger);

    await store.claim('room-1', 'user-1');
    await store.claim('room-1', 'user-1');
    await store.release('room-1', 'user-2');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('7.4');
  });

  it('refuses to send a non-finite TTL to Redis', async () => {
    const { redis, calls } = makeRedis([1]);
    const store = createRedisTypingStore({
      redis,
      instanceId: 'alpha',
      ttlMs: Number.NaN,
    });

    await store.claim('room-1', 'user-1');
    expect(calls[0].args[4]).toBe('3000');
  });
});
