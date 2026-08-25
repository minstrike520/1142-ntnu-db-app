import { describe, it, expect } from 'bun:test';
import {
  createRedisManager,
  DEFAULT_WATCHDOG_INTERVAL_MS,
  REDIS_ROLES,
  type IntervalHandle,
  type RedisConnection,
  type RedisMessageHandler,
  type RedisRole,
} from '../../../src/utils/redis';
import { createLogger, createRecentLogStore } from '../../../src/utils/logger';

const URL = 'redis://redis:6379';

/**
 * A logger that writes nowhere.
 *
 * Not the shared `logger`: its records land in the process-wide recent-log ring
 * buffer that the admin `/logs` endpoint reads, and a reconnect suite emits
 * enough warnings to evict everything else another test might assert on.
 */
const quietLogger = () =>
  createLogger({
    level: 'silent',
    pretty: false,
    store: createRecentLogStore(),
    stdout: { write: () => true } as unknown as NodeJS.WritableStream,
  });

interface FakeConnection extends RedisConnection {
  readonly role: RedisRole;
  readonly sent: { command: string; args: string[] }[];
  readonly published: { channel: string; message: string }[];
  readonly subscribeCalls: string[];
  /**
   * Every listener still registered, per channel, in registration order.
   *
   * A list rather than one entry per channel because that is what Bun's client
   * actually does: it appends, and de-duplicates nothing — subscribing a channel
   * twice makes each message invoke the handler twice, even with the same
   * function reference. Modelling it as last-writer-wins is what let an earlier
   * version of this fake pass while the module leaked a listener per reconnect.
   */
  readonly listeners: Map<string, RedisMessageHandler[]>;
  closes: number;
  unsubscribes: number;
  connectCalls: number;
  /** Makes the next `connect()` reject, as an unreachable server would. */
  failConnect: boolean;
  /** Makes `unsubscribe()` never settle, as a dead socket does. */
  hangUnsubscribe: boolean;
  /**
   * Makes the two-argument `unsubscribe` reject, as a drop mid-round-trip does.
   *
   * Only that form: the bare `unsubscribe()` is what retirement uses to leave
   * subscriber mode, and a connection being replaced still has to close.
   */
  failUnsubscribe: boolean;
  /** Makes every command reject, as a mid-flight drop does. */
  failCommands: boolean;
  /**
   * Holds `connect()` open until `settleConnect()` is called.
   *
   * Without this the fake's `connect()` resolves synchronously and fires
   * `onconnect` before the caller ever reaches its `await`, which hides both the
   * in-flight window the `connecting` guard protects and the fallback path that
   * runs when a client resolves `connect()` without announcing.
   */
  deferConnect: boolean;
  /** With `deferConnect`, whether resolving should also fire `onconnect`. */
  announceOnConnect: boolean;
  /**
   * Holds `subscribe()` open until `settleSubscribe()` is called.
   *
   * The window a real round trip leaves open, and the only way to test what an
   * operation arriving in the middle of one observes.
   */
  deferSubscribe: boolean;
  settleConnect(): void;
  /** Release the held `subscribe()`, and stop holding later ones. */
  settleSubscribe(): void;
  /** Drop the connection the way Bun does for a retryable blip: silently. */
  drop(): void;
  /** Deliver a message as the server would. */
  emit(channel: string, message: string): void;
}

const createFakeConnection = (role: RedisRole): FakeConnection => {
  let pendingConnect: (() => void) | undefined;
  let pendingSubscribe: (() => void) | undefined;
  const fake: FakeConnection = {
    role,
    connected: false,
    onconnect: null,
    onclose: null,
    sent: [],
    published: [],
    subscribeCalls: [],
    listeners: new Map(),
    closes: 0,
    unsubscribes: 0,
    connectCalls: 0,
    failConnect: false,
    hangUnsubscribe: false,
    failUnsubscribe: false,
    failCommands: false,
    deferConnect: false,
    announceOnConnect: true,
    deferSubscribe: false,

    settleConnect() {
      const release = pendingConnect;
      pendingConnect = undefined;
      release?.();
    },
    settleSubscribe() {
      fake.deferSubscribe = false;
      const release = pendingSubscribe;
      pendingSubscribe = undefined;
      release?.();
    },

    async connect() {
      fake.connectCalls += 1;
      if (fake.failConnect) throw new Error(`connect refused for ${role}`);
      if (fake.deferConnect) {
        await new Promise<void>((resolve) => {
          pendingConnect = resolve;
        });
      }
      (fake as { connected: boolean }).connected = true;
      if (fake.announceOnConnect) fake.onconnect?.();
      return undefined;
    },
    close() {
      fake.closes += 1;
      (fake as { connected: boolean }).connected = false;
    },
    async send(command, args) {
      if (fake.failCommands) throw new Error(`${command} failed`);
      fake.sent.push({ command, args });
      return `${command}-result`;
    },
    async publish(channel, message) {
      if (fake.failCommands) throw new Error('publish failed');
      fake.published.push({ channel, message });
      return 1;
    },
    async subscribe(channel, listener) {
      if (fake.failCommands) throw new Error('subscribe failed');
      if (fake.deferSubscribe) {
        await new Promise<void>((resolve) => {
          pendingSubscribe = resolve;
        });
      }
      fake.subscribeCalls.push(channel);
      fake.listeners.set(channel, [...(fake.listeners.get(channel) ?? []), listener]);
      return fake.listeners.size;
    },
    async unsubscribe(channel?: string, listener?: RedisMessageHandler) {
      if (channel === undefined) {
        fake.unsubscribes += 1;
        if (fake.hangUnsubscribe) await new Promise<void>(() => {});
        fake.listeners.clear();
        return;
      }
      if (fake.failUnsubscribe) throw new Error(`unsubscribe refused for ${channel}`);
      const remaining = (fake.listeners.get(channel) ?? []).filter((entry) => entry !== listener);
      if (remaining.length > 0) fake.listeners.set(channel, remaining);
      else fake.listeners.delete(channel);
    },

    drop() {
      // Deliberately without calling `onclose`: the real client does not fire it
      // for a drop it intends to retry, which is why the watchdog exists.
      (fake as { connected: boolean }).connected = false;
    },
    emit(channel, message) {
      for (const listener of fake.listeners.get(channel) ?? []) listener(message, channel);
    },
  };
  return fake;
};

interface Harness {
  connections: FakeConnection[];
  byRole(role: RedisRole): FakeConnection;
  /** Every connection ever built for a role, oldest first. */
  allFor(role: RedisRole): FakeConnection[];
  tick(): void;
  /** Configure each connection the manager builds from now on. */
  onBuild(configure: (connection: FakeConnection) => void): void;
  cleared: IntervalHandle[];
  intervals: number[];
}

const createHarness = () => {
  const connections: FakeConnection[] = [];
  const cleared: IntervalHandle[] = [];
  const intervals: number[] = [];
  let scheduled: (() => void) | undefined;
  let handles = 0;
  let configure: ((connection: FakeConnection) => void) | undefined;

  const harness: Harness = {
    connections,
    allFor: (role) => connections.filter((connection) => connection.role === role),
    byRole: (role) => {
      const forRole = harness.allFor(role);
      const latest = forRole.at(-1);
      if (!latest) throw new Error(`no connection built for ${role}`);
      return latest;
    },
    tick: () => scheduled?.(),
    onBuild: (next) => {
      configure = next;
    },
    cleared,
    intervals,
  };

  const manager = createRedisManager({
    url: URL,
    logger: quietLogger(),
    connectionFactory: (_url, role) => {
      const connection = createFakeConnection(role);
      configure?.(connection);
      connections.push(connection);
      return connection;
    },
    setIntervalFn: (handler, ms) => {
      scheduled = handler;
      intervals.push(ms);
      handles += 1;
      return handles;
    },
    clearIntervalFn: (handle) => {
      cleared.push(handle);
      scheduled = undefined;
    },
  });

  return { manager, harness };
};

/**
 * Let the fire-and-forget work the manager schedules finish before asserting.
 *
 * Both the watchdog's reconnect and the retirement of the connection it replaces
 * are detached on purpose, so a test that asserted immediately would race them.
 */
const settle = () => Bun.sleep(5);

describe('redis manager', () => {
  describe('construction', () => {
    it('opens no connection until connect() is called', () => {
      const { harness } = createHarness();

      // The unit CI job has no Redis at all, so a manager that dialled here
      // would fail every suite that transitively builds one.
      expect(harness.connections).toHaveLength(0);
      expect(harness.intervals).toHaveLength(0);
    });

    it('reports every role as idle before connecting', () => {
      const { manager } = createHarness();

      expect(manager.status.ready).toBe(false);
      expect(manager.status.roles.map((entry) => entry.state)).toEqual(['idle', 'idle', 'idle']);
      expect(manager.status.target).toBe('redis:6379/0');
    });
  });

  describe('connect', () => {
    it('opens one connection per role and starts the watchdog', async () => {
      const { manager, harness } = createHarness();

      await manager.connect();

      expect(harness.connections.map((connection) => connection.role)).toEqual([...REDIS_ROLES]);
      expect(harness.intervals).toEqual([DEFAULT_WATCHDOG_INTERVAL_MS]);
      expect(manager.status.ready).toBe(true);
    });

    it('gives pub/sub its own connection, separate from commands', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();

      const command = harness.byRole('command');
      const publisher = harness.byRole('publisher');
      const subscriber = harness.byRole('subscriber');

      // A subscribed Redis connection accepts only subscription commands, so
      // sharing one would make every ordinary command fail once anything
      // subscribed. Three distinct objects is the whole point of the split.
      expect(new Set([command, publisher, subscriber]).size).toBe(3);
    });

    it('resolves rather than rejecting when Redis is unreachable', async () => {
      const { manager, harness } = createHarness();
      const built: FakeConnection[] = [];
      const failing = createRedisManager({
        url: URL,
        logger: quietLogger(),
        connectionFactory: (_url, role) => {
          const connection = createFakeConnection(role);
          connection.failConnect = true;
          built.push(connection);
          return connection;
        },
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
      });

      // The API serves every REST route without Redis; a boot that fails here
      // would take the whole process down over derived state.
      await failing.connect();

      expect(built).toHaveLength(3);
      expect(failing.status.ready).toBe(false);
      expect(failing.status.roles.every((entry) => entry.state === 'unavailable')).toBe(true);
      expect(harness.connections).toHaveLength(0);
      await failing.close();
    });
  });

  describe('commands', () => {
    it('sends commands on the command connection', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();

      const result = await manager.command('SET', ['k', 'v', 'PX', '3000']);

      expect(result).toEqual({ ok: true, value: 'SET-result' });
      expect(harness.byRole('command').sent).toEqual([
        { command: 'SET', args: ['k', 'v', 'PX', '3000'] },
      ]);
      expect(harness.byRole('publisher').sent).toHaveLength(0);
    });

    it('publishes on the publisher connection, never the subscriber', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      await manager.subscribe('near-chat-ws', () => {});

      const result = await manager.publish('near-chat-ws', '{"event":"x"}');

      expect(result).toEqual({ ok: true, value: 1 });
      expect(harness.byRole('publisher').published).toEqual([
        { channel: 'near-chat-ws', message: '{"event":"x"}' },
      ]);
      expect(harness.byRole('subscriber').published).toHaveLength(0);
    });

    it('reports a failure instead of throwing, and counts it', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      harness.byRole('command').failCommands = true;

      const result = await manager.command('GET', ['k']);

      expect(result.ok).toBe(false);
      expect(manager.status.failedCommands).toBe(1);
      expect(manager.status.lastError?.role).toBe('command');
    });

    it('reports unavailable rather than throwing while the connection is down', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      harness.byRole('command').drop();
      harness.byRole('publisher').drop();

      const command = await manager.command('GET', ['k']);
      const publish = await manager.publish('near-chat-ws', 'x');

      expect(command.ok).toBe(false);
      expect(publish.ok).toBe(false);
      expect(manager.status.failedCommands).toBe(1);
      expect(manager.status.failedPublishes).toBe(1);
      expect(manager.status.ready).toBe(false);
    });

    it('pings on the command connection and answers false when it is down', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();

      expect(await manager.ping()).toBe(true);
      harness.byRole('command').drop();
      expect(await manager.ping()).toBe(false);
    });
  });

  describe('subscriptions', () => {
    it('subscribes on the subscriber connection and dispatches messages', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const received: string[] = [];

      await manager.subscribe('near-chat-ws', (message, channel) =>
        received.push(`${channel}:${message}`),
      );
      harness.byRole('subscriber').emit('near-chat-ws', 'hello');

      expect(harness.byRole('subscriber').subscribeCalls).toEqual(['near-chat-ws']);
      expect(received).toEqual(['near-chat-ws:hello']);
    });

    it('issues one wire subscription per channel however many handlers want it', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const received: string[] = [];

      await manager.subscribe('room', () => received.push('first'));
      await manager.subscribe('room', () => received.push('second'));
      harness.byRole('subscriber').emit('room', 'x');

      expect(harness.byRole('subscriber').subscribeCalls).toEqual(['room']);
      expect(received).toEqual(['first', 'second']);
    });

    it('keeps delivering to the other handlers when one throws', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const received: string[] = [];

      await manager.subscribe('room', () => {
        throw new Error('handler exploded');
      });
      await manager.subscribe('room', () => received.push('survivor'));
      harness.byRole('subscriber').emit('room', 'x');

      expect(received).toEqual(['survivor']);
    });

    it('unsubscribes on the wire only once the last handler is gone', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const first: RedisMessageHandler = () => {};
      const second: RedisMessageHandler = () => {};
      await manager.subscribe('room', first);
      await manager.subscribe('room', second);

      await manager.unsubscribe('room', first);
      expect(harness.byRole('subscriber').listeners.get('room')).toHaveLength(1);
      expect(manager.status.subscribedChannels).toEqual(['room']);

      await manager.unsubscribe('room', second);
      // Removed through the client, never as a raw `UNSUBSCRIBE` command: the
      // raw form leaves Bun's listener registered, so re-subscribing the channel
      // later would deliver every message twice.
      expect(harness.byRole('subscriber').sent).toHaveLength(0);
      expect(harness.byRole('subscriber').listeners.get('room')).toBeUndefined();
      expect(manager.status.subscribedChannels).toEqual([]);
    });

    it('delivers once after a channel is dropped and taken up again', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const first: RedisMessageHandler = () => {};
      await manager.subscribe('room', first);
      await manager.unsubscribe('room', first);

      const received: string[] = [];
      await manager.subscribe('room', (message) => received.push(message));
      harness.byRole('subscriber').emit('room', 'x');

      expect(received).toEqual(['x']);
    });

    it('remembers a channel it could not subscribe to while Redis was down', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      harness.byRole('subscriber').drop();

      const result = await manager.subscribe('room', () => {});

      expect(result.ok).toBe(false);
      // The caller asked to be subscribed and the outage is temporary, so the
      // intent has to survive for the reconnect to replay.
      expect(manager.status.subscribedChannels).toEqual(['room']);
    });

    it('re-issues a subscription the first attempt never landed', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const subscriber = harness.byRole('subscriber');

      // A rejected command rather than a dropped socket — an ACL `NOPERM` is
      // the real-world shape. Nothing will rebuild a connection that stays up,
      // so if this registration is treated as complete the channel is deaf for
      // the lifetime of the process.
      subscriber.failCommands = true;
      expect((await manager.subscribe('room', () => {})).ok).toBe(false);
      expect(subscriber.connected).toBe(true);
      expect(subscriber.subscribeCalls).toEqual([]);

      subscriber.failCommands = false;
      const received: string[] = [];
      const second = await manager.subscribe('room', (message) => received.push(message));

      expect(second.ok).toBe(true);
      expect(subscriber.subscribeCalls).toEqual(['room']);
      subscriber.emit('room', 'x');
      expect(received).toEqual(['x']);
    });

    it('reports a removal that did not happen instead of claiming success', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const subscriber = harness.byRole('subscriber');
      const handler: RedisMessageHandler = () => {};
      await manager.subscribe('room', handler);

      subscriber.failUnsubscribe = true;
      const result = await manager.unsubscribe('room', handler);

      expect(result.ok).toBe(false);
      // Still registered on a connection that is perfectly healthy, and the
      // reference needed to remove it is the one that just failed.
      expect(subscriber.listeners.get('room')).toHaveLength(1);
      expect(manager.status.subscribedChannels).toEqual([]);
    });

    it('replaces a subscriber still holding a listener it cannot remove', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const first = harness.byRole('subscriber');
      const handler: RedisMessageHandler = () => {};
      await manager.subscribe('room', handler);

      first.failUnsubscribe = true;
      await manager.unsubscribe('room', handler);
      // Healthy by every signal the watchdog normally reads, and replaced
      // anyway: a listener nothing can remove is not recoverable in place.
      expect(first.connected).toBe(true);
      harness.tick();
      await settle();

      expect(harness.allFor('subscriber')).toHaveLength(2);
      const second = harness.byRole('subscriber');
      const received: string[] = [];
      await manager.subscribe('room', (message) => received.push(message));
      second.emit('room', 'x');

      expect(received).toEqual(['x']);
    });

    it('does not let an unsubscribe overtake a subscribe on the same channel', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const subscriber = harness.byRole('subscriber');
      const handler: RedisMessageHandler = () => {};

      subscriber.deferSubscribe = true;
      const subscribing = manager.subscribe('room', handler);
      const unsubscribing = manager.unsubscribe('room', handler);
      subscriber.settleSubscribe();
      await subscribing;
      await unsubscribing;

      // Unserialised, the unsubscribe reads the bookkeeping mid-write: it finds
      // no listener to remove, reports success, and the subscribe then registers
      // one for a channel nobody is subscribed to any more.
      expect(manager.status.subscribedChannels).toEqual([]);
      expect(subscriber.listeners.get('room')).toBeUndefined();

      const received: string[] = [];
      await manager.subscribe('room', (message) => received.push(message));
      subscriber.emit('room', 'x');

      // The listener left behind would have made this two.
      expect(received).toEqual(['x']);
    });
  });

  describe('reconnection', () => {
    it('re-issues every subscription after the connection comes back', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const received: string[] = [];
      await manager.subscribe('near-chat-ws', (message) => received.push(message));
      await manager.subscribe('presence', (message) => received.push(message));

      // Bun's client reconnects on its own and fires `onconnect` again on the
      // same connection, but tells the server nothing about the old
      // subscriptions. Without the registry replay this instance would look
      // healthy and receive nothing, forever. Note the fake does NOT drop its
      // listeners here: Bun keeps them, and that is the second half of the
      // problem.
      const subscriber = harness.byRole('subscriber');
      subscriber.onconnect?.();
      await settle();

      expect(subscriber.subscribeCalls).toEqual([
        'near-chat-ws',
        'presence',
        'near-chat-ws',
        'presence',
      ]);

      subscriber.emit('near-chat-ws', 'after-reconnect');
      expect(received).toEqual(['after-reconnect']);
    });

    it('delivers each message once however many times it has reconnected', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const received: string[] = [];
      await manager.subscribe('near-chat-ws', (message) => received.push(message));
      const subscriber = harness.byRole('subscriber');

      // Bun accumulates listeners and de-duplicates nothing, so replaying the
      // registry without first removing the previous listener adds a copy per
      // reconnect: measured against a real Redis, three drops took one PUBLISH
      // from one handler call to four.
      for (let reconnect = 0; reconnect < 3; reconnect += 1) {
        subscriber.onconnect?.();
        await settle();
      }
      subscriber.emit('near-chat-ws', 'once');

      expect(received).toEqual(['once']);
      expect(subscriber.listeners.get('near-chat-ws')).toHaveLength(1);
    });

    it('replaces a connection the client has given up on, and resubscribes', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      await manager.subscribe('near-chat-ws', () => {});
      const original = harness.byRole('subscriber');

      // A client whose retry budget is exhausted never recovers and `connect()`
      // on it never settles, so the watchdog builds a new one instead.
      original.drop();
      harness.tick();
      await settle();

      const replacement = harness.byRole('subscriber');
      expect(replacement).not.toBe(original);
      expect(original.closes).toBe(1);
      expect(replacement.subscribeCalls).toEqual(['near-chat-ws']);
      expect(manager.status.reconnects).toBeGreaterThan(0);
      expect(manager.status.ready).toBe(true);
    });

    it('retries a subscription the replay could not restore', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const subscriber = harness.byRole('subscriber');
      const received: string[] = [];
      await manager.subscribe('room', (message) => received.push(message));

      // Bun reconnects on its own, and the replay's SUBSCRIBE is rejected by a
      // connection that stays up. Nothing is left to act on: the socket is
      // healthy so no reconnect is coming, and the caller that asked for this
      // channel has no reason to ask again.
      subscriber.failCommands = true;
      subscriber.onconnect?.();
      await settle();
      expect(subscriber.listeners.get('room')).toBeUndefined();

      subscriber.failCommands = false;
      harness.tick();
      await settle();
      subscriber.emit('room', 'x');

      expect(received).toEqual(['x']);
    });

    it('leaves a subscribe that is merely slow alone', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const subscriber = harness.byRole('subscriber');

      // A first SUBSCRIBE whose round trip outlasts a watchdog interval — a
      // congested Redis, with TCP perfectly healthy. Mid-flight it looks exactly
      // like a channel that never reached the wire.
      subscriber.deferSubscribe = true;
      const subscribing = manager.subscribe('room', () => {});
      // The channel queue starts its operation in a microtask, so let the
      // registration land before the tick — otherwise the repair pass has
      // nothing to look at and the test proves nothing.
      await settle();
      harness.tick();
      await settle();
      subscriber.settleSubscribe();
      await subscribing;

      harness.tick();
      await settle();

      // A second attach queued behind the first would have found the listener
      // in place, read it as a removal that failed, and replaced a connection
      // with nothing wrong with it.
      expect(harness.allFor('subscriber')).toHaveLength(1);
      expect(subscriber.subscribeCalls).toEqual(['room']);
    });

    it('leaves healthy connections alone', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();

      harness.tick();
      await settle();

      expect(harness.connections).toHaveLength(3);
      expect(manager.status.reconnects).toBe(0);
    });

    it('does not stack attempts while a connect is still in flight', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();

      // The guard only matters during the window between starting a connect and
      // it completing, so the replacement's connect is held open. A fake that
      // resolves immediately would make this test pass with the guard deleted.
      const replacementsHeld: FakeConnection[] = [];
      harness.onBuild((connection) => {
        if (connection.role !== 'command') return;
        connection.deferConnect = true;
        replacementsHeld.push(connection);
      });

      harness.byRole('command').drop();
      harness.tick();
      await settle();
      harness.tick();
      harness.tick();
      await settle();

      // One replacement, not three.
      expect(replacementsHeld).toHaveLength(1);
      expect(harness.allFor('command')).toHaveLength(2);

      replacementsHeld[0]?.settleConnect();
      await settle();
      expect(manager.status.ready).toBe(true);
    });

    it('restores subscriptions even when connect() resolves without announcing', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      await manager.subscribe('near-chat-ws', () => {});

      // A client that resolves `connect()` without firing `onconnect` would
      // otherwise leave a live subscriber holding no subscriptions at all.
      harness.onBuild((connection) => {
        if (connection.role !== 'subscriber') return;
        connection.announceOnConnect = false;
      });
      harness.byRole('subscriber').drop();
      harness.tick();
      await settle();

      const replacement = harness.byRole('subscriber');
      expect(replacement.subscribeCalls).toEqual(['near-chat-ws']);
      expect(replacement.listeners.get('near-chat-ws')).toHaveLength(1);
    });

    it('marks a role unavailable when the client reports a close', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();

      harness.byRole('publisher').onclose?.(new Error('connection reset'));

      expect(manager.status.roles.find((entry) => entry.role === 'publisher')?.state).toBe(
        'unavailable',
      );
      expect(manager.status.lastError?.message).toBe('connection reset');
    });

    it('ignores callbacks from a connection it has already retired', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      const original = harness.byRole('command');

      original.drop();
      harness.tick();
      await settle();
      expect(manager.status.ready).toBe(true);

      // The retired client keeps its callbacks — clearing them panics Bun — so
      // a late event from it must not be able to mark the live role down.
      original.onclose?.(new Error('late failure from a retired connection'));

      expect(manager.status.roles.find((entry) => entry.role === 'command')?.state).toBe('ready');
    });
  });

  describe('shutdown', () => {
    it('leaves subscriber mode before closing, then closes every connection', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();
      await manager.subscribe('near-chat-ws', () => {});

      await manager.close();

      // Closing a connection that is still subscribed leaves an event-loop
      // handle alive and the process then never exits on its own.
      expect(harness.byRole('subscriber').unsubscribes).toBe(1);
      for (const role of REDIS_ROLES) expect(harness.byRole(role).closes).toBe(1);
      expect(manager.status.roles.every((entry) => entry.state === 'closed')).toBe(true);
    });

    it('stops the watchdog so nothing reconnects after shutdown', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();

      await manager.close();
      harness.tick();
      await settle();

      expect(harness.cleared).toHaveLength(1);
      expect(harness.connections).toHaveLength(3);
    });

    it('is idempotent', async () => {
      const { manager, harness } = createHarness();
      await manager.connect();

      await manager.close();
      await manager.close();

      expect(harness.byRole('command').closes).toBe(1);
    });

    it('resolves before connect() has ever been called', async () => {
      const { manager, harness } = createHarness();

      await manager.close();

      expect(harness.connections).toHaveLength(0);
    });

    it('does not hang when the connection is already gone', async () => {
      const built: FakeConnection[] = [];
      const manager = createRedisManager({
        url: URL,
        logger: quietLogger(),
        closeTimeoutMs: 5,
        connectionFactory: (_url, role) => {
          const connection = createFakeConnection(role);
          built.push(connection);
          return connection;
        },
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
      });
      await manager.connect();
      await manager.subscribe('near-chat-ws', () => {});
      const subscriber = built.find((connection) => connection.role === 'subscriber')!;
      subscriber.hangUnsubscribe = true;

      // A deployment must never be held open by an unreachable Redis.
      await manager.close();

      expect(subscriber.closes).toBe(1);
    });

    it('reports a connection that throws on close instead of failing shutdown', async () => {
      const built: FakeConnection[] = [];
      const manager = createRedisManager({
        url: URL,
        logger: quietLogger(),
        connectionFactory: (_url, role) => {
          const connection = createFakeConnection(role);
          connection.close = () => {
            throw new Error('socket already gone');
          };
          built.push(connection);
          return connection;
        },
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
      });
      await manager.connect();

      await manager.close();

      expect(built).toHaveLength(3);
    });
  });

  describe('without REDIS_URL', () => {
    const createDisabled = () => {
      const built: FakeConnection[] = [];
      const intervals: number[] = [];
      const manager = createRedisManager({
        url: undefined,
        logger: quietLogger(),
        connectionFactory: (_url, role) => {
          const connection = createFakeConnection(role);
          built.push(connection);
          return connection;
        },
        setIntervalFn: (_handler, ms) => {
          intervals.push(ms);
          return 1;
        },
        clearIntervalFn: () => {},
      });
      return { manager, built, intervals };
    };

    it('never connects and never schedules a watchdog', async () => {
      const { manager, built, intervals } = createDisabled();

      await manager.connect();

      expect(built).toHaveLength(0);
      expect(intervals).toHaveLength(0);
      expect(manager.status.target).toBe('unconfigured');
      expect(manager.status.roles.every((entry) => entry.state === 'disabled')).toBe(true);
    });

    it('answers every operation without throwing', async () => {
      const { manager } = createDisabled();
      await manager.connect();

      expect((await manager.command('GET', ['k'])).ok).toBe(false);
      expect((await manager.publish('near-chat-ws', 'x')).ok).toBe(false);
      expect((await manager.subscribe('near-chat-ws', () => {})).ok).toBe(false);
      expect(await manager.ping()).toBe(false);
      await manager.close();
    });
  });
});
