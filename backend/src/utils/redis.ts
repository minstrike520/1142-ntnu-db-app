import { RedisClient } from 'bun';
import type pino from 'pino';
import { describeRedisTarget } from './describeRedisTarget';
import { logger as defaultLogger } from './logger';

/**
 * The process's Redis connections and their lifecycle.
 *
 * Redis holds only derived, recoverable state here — presence leases, typing
 * TTLs, routing metadata and the realtime pub/sub fan-out. PostgreSQL stays
 * canonical (the reasoning is spelled out on the `redis` service in
 * docker-compose.yml). Everything in this module follows from that: a Redis
 * outage costs liveness of realtime fan-out, never committed data, so it must
 * degrade the process rather than stop it.
 *
 * Three connections, not one:
 *
 * - **subscriber** — a Redis connection that has issued SUBSCRIBE accepts only
 *   subscription commands, `PING` and `QUIT`. This is not a convention that can
 *   be bent: calling `get()` on a subscribed Bun client throws
 *   `ERR_REDIS_INVALID_STATE` *synchronously*, so it would escape a bare
 *   `await`ed try/catch in a socket handler. The subscriber is therefore never
 *   handed out; only `subscribe`/`unsubscribe` reach it.
 * - **publisher** — separate from `command` so a broadcast never queues behind
 *   presence and typing writes on the same auto-pipelined connection. Unlike
 *   the subscriber split this one is a latency choice, not a Redis rule.
 * - **command** — everything else, reached through `command()`.
 *
 * ## Why this module is more than three constructor calls
 *
 * Bun's native Redis client is fast and needs no dependency, but three of its
 * behaviours have to be compensated for here. All three were reproduced against
 * `redis:8-alpine` on both the pinned Bun 1.3.14 and on 1.4.0:
 *
 * 1. **It does not re-issue SUBSCRIBE after an automatic reconnect.** The
 *    reconnect itself works — `onconnect` fires again and `connected` flips back
 *    to `true` — but the new connection sends only `HELLO`, so the server has no
 *    record of the subscription. A later PUBLISH reports `0` receivers and the
 *    listener is never called again: the instance goes *silently deaf* while
 *    looking perfectly healthy. This module therefore owns the subscription
 *    registry (`channels` below) and re-issues every channel on each
 *    `onconnect`. That is the single most important thing here.
 * 2. **`onclose` is not fired on a drop the client intends to retry.** In the
 *    same run it fired only on the explicit `close()` at the end. So no
 *    reconnect logic may hang off `onclose`; `connected` polled by the watchdog
 *    is the trustworthy signal.
 * 3. **`close()` on a connection still in subscriber mode never releases the
 *    event loop**, and the process then hangs at exit instead of terminating.
 *    Issuing `unsubscribe()` first fixes it — including after a reconnect — so
 *    every connection this module retires goes through `retire()`, which
 *    unsubscribes first.
 * 4. **Assigning `null` to `onconnect` or `onclose` and then calling `close()`
 *    panics the runtime** — `panic(main thread): A JavaScript exception was
 *    thrown, but it was cleared before it could be read`, aborting the process
 *    with SIGILL. That is why `attachHandlers` hands back a `detach()` that
 *    flips a flag the callbacks read, and why nothing here ever clears a
 *    callback.
 *
 * A fifth behaviour cannot be worked around at all, only compensated for: once
 * Bun's internal retry budget (`maxRetries`) is exhausted, that client is dead
 * for good. It does not recover when Redis comes back, and `connect()` on it
 * never settles — not a rejection, no timeout, just a promise that is never
 * resolved. So a connection this module gives up on is *replaced*, never
 * revived; that is what the watchdog does.
 *
 * A sixth has no workaround at this layer at all, and is called out here so it
 * is not mistaken for a bug in this file: **a connection that has dropped never
 * releases its event-loop handle, even after `close()`.** Isolated to exactly
 * that — connect, stop Redis, close — with no subscription involved; the same
 * script against a Redis that stays up exits immediately. A process that has
 * seen a Redis outage therefore will not exit on its own, which is why
 * `src/index.ts` ends its shutdown with an explicit `process.exit(0)` rather
 * than letting the event loop drain. That call is load-bearing: without it a
 * container that survived an outage would hang on SIGTERM until the
 * orchestrator SIGKILLs it.
 *
 * ## Testability
 *
 * Nothing here dials on import and there is no module-level singleton: the
 * composition root builds a manager, and the unit-test tier — which has no
 * Redis, no database and no `.env` — never opens a socket. Both the connection
 * factory and the timer functions are injectable, so the unit tests drive
 * reconnects and shutdown without a live server and without real delays. This
 * is the `AvatarStore` seam pattern (`utils/avatarUpload.ts`), not
 * `mock.module()`, which `tests/CLAUDE.md` bans for good reason.
 */

/** Callback shape Bun hands a subscription listener. */
export type RedisMessageHandler = (message: string, channel: string) => void;

export type RedisRole = 'command' | 'publisher' | 'subscriber';

export const REDIS_ROLES: readonly RedisRole[] = ['command', 'publisher', 'subscriber'];

/**
 * How often the watchdog re-checks a connection it believes is down.
 *
 * Flat rather than exponential on purpose. Bun already runs a fast internal
 * retry loop with its own backoff; this interval is only the *outer* net that
 * catches the case where that loop has given up for good. One attempt every few
 * seconds against a down Redis is not a busy loop, and a flat cadence keeps the
 * recovery time bounded and easy to state: a returning Redis is picked up within
 * one tick.
 */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000;

/**
 * Ceiling on how long shutdown may spend on Redis.
 *
 * A deployment must not be held open by an unreachable Redis, so every close
 * step races this timeout and the process continues regardless — the same
 * bounded-fallback shape as the force-stop in `bootstrap/realtime.ts`.
 */
export const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

/** Handed to Bun; only reached if a connect attempt cannot complete at all. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * The result of an operation that is allowed to fail without failing its caller.
 *
 * A discriminated union rather than a rejected promise, because every caller of
 * this module is on a path where Redis being down is a *degraded mode*, not an
 * error: the socket handlers in `realtime/` currently do no more than
 * `.catch(console.error)`, so a rejection would be swallowed silently and the
 * caller would carry on as if the write had happened. Being forced to look at
 * `ok` is the point.
 *
 * `ok: true` means Redis accepted the command. For `publish` in particular that
 * is *not* a delivery guarantee — Redis Pub/Sub drops messages with no live
 * subscriber, and recovery from any such gap is the message sync cursor's job,
 * never a Redis replay.
 */
export type RedisOutcome<T> = { ok: true; value: T } | { ok: false; error: Error };

export type RedisConnectionState =
  /** Constructed, no connection attempted yet. */
  | 'idle'
  /** No `REDIS_URL` configured; this process will never try to connect. */
  | 'disabled'
  /** A connect attempt is in flight. */
  | 'connecting'
  /** Connected and usable. */
  | 'ready'
  /** Not usable; the watchdog is retrying. */
  | 'unavailable'
  /** Deliberately shut down; no further attempts will be made. */
  | 'closed';

export interface RedisRoleStatus {
  role: RedisRole;
  state: RedisConnectionState;
}

/**
 * The operational view of this module, for logs, the admin surface and tests.
 *
 * Counters rather than per-failure logs: an outage produces one failed command
 * per presence write per connected user, and the recent-log ring buffer holds
 * 200 records total, so logging each one would evict every other diagnostic in
 * the process within seconds.
 */
export interface RedisStatus {
  /** Log-safe `host:port/db`; never the URL, which can carry a password. */
  target: string;
  /** True only when every role is connected. */
  ready: boolean;
  roles: RedisRoleStatus[];
  /** Channels this process intends to be subscribed to. */
  subscribedChannels: string[];
  /** Connections rebuilt by the watchdog since startup. */
  reconnects: number;
  failedCommands: number;
  failedPublishes: number;
  lastError?: { role: RedisRole; message: string; code?: string };
}

/**
 * The slice of Bun's `RedisClient` this module drives.
 *
 * Deliberately narrow. Typing the seam as the whole client would force every
 * test fake to model a few hundred command methods and would pin the tests to a
 * Bun version; `send()` reaches every Redis command that is not listed here, so
 * nothing is actually given up.
 */
export interface RedisConnection {
  readonly connected: boolean;
  onconnect: (() => void) | null;
  onclose: ((error: Error) => void) | null;
  connect(): Promise<unknown>;
  close(): void;
  send(command: string, args: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: RedisMessageHandler): Promise<number>;
  /** Leave every channel, which is also what clears subscriber mode. */
  unsubscribe(): Promise<void>;
  /**
   * Drop one specific listener.
   *
   * The two-argument form is not a convenience: it is the only way to remove a
   * listener from Bun's client. A bare `UNSUBSCRIBE` sent as a raw command
   * leaves the server unsubscribed but the client-side listener registered, so
   * the next `subscribe` on that connection stacks a second one.
   */
  unsubscribe(channel: string, listener: RedisMessageHandler): Promise<void>;
}

export type RedisConnectionFactory = (url: string, role: RedisRole) => RedisConnection;

/**
 * Whatever an interval scheduler hands back.
 *
 * Named once rather than written as `ReturnType<typeof setInterval>` at each use
 * site: both the DOM and the Node/Bun lib declarations of `setInterval` are in
 * scope here and they disagree (`number` versus `Timeout`), so the same
 * expression resolves to different halves of that union depending on where it
 * appears. The handle is opaque to this module — it is only ever passed back to
 * the matching clear function.
 */
export type IntervalHandle = ReturnType<typeof setInterval> | number;

export interface RedisManager {
  readonly status: RedisStatus;
  /**
   * Open every connection. Never rejects: a Redis that is unreachable at boot
   * leaves the manager in `unavailable` and hands recovery to the watchdog,
   * because the API serves every REST route without Redis and a container that
   * refuses to become healthy over a derived-state store is strictly worse than
   * one running degraded.
   */
  connect(): Promise<void>;
  /** Any Redis command, by name. Uses the command connection. */
  command<T = unknown>(command: string, args?: string[]): Promise<RedisOutcome<T>>;
  /** Uses the publisher connection. Success means "accepted", not "delivered". */
  publish(channel: string, message: string): Promise<RedisOutcome<number>>;
  /**
   * Register a handler and subscribe if this is the channel's first handler.
   * The registration survives reconnects; the subscription is re-issued for you.
   */
  subscribe(channel: string, handler: RedisMessageHandler): Promise<RedisOutcome<void>>;
  /** Drop one handler, unsubscribing once a channel has none left. */
  unsubscribe(channel: string, handler: RedisMessageHandler): Promise<RedisOutcome<void>>;
  /** Round-trips the command connection. False rather than throwing when down. */
  ping(): Promise<boolean>;
  /** Idempotent, bounded, and never rejects. Safe to call before `connect()`. */
  close(): Promise<void>;
}

export interface CreateRedisManagerOptions {
  /**
   * Resolved by `config/env.ts`; this module never reads `process.env`.
   *
   * `undefined` builds a manager that never connects and answers every
   * operation with `{ ok: false }`. That is deliberately a working manager
   * rather than an absent one: a deployment without Redis is supported, and
   * making the composition root hand `RedisManager | undefined` down to
   * presence, typing and the publisher would put a null check on every realtime
   * path to express a state those paths already have to handle anyway — Redis
   * configured but down.
   */
  url: string | undefined;
  logger?: pino.Logger;
  /** Replaced by unit tests so no socket is ever opened. */
  connectionFactory?: RedisConnectionFactory;
  watchdogIntervalMs?: number;
  closeTimeoutMs?: number;
  /** Injected so tests drive the watchdog synchronously instead of waiting. */
  setIntervalFn?: (handler: () => void, ms: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
}

/**
 * Build a Bun Redis connection with the options this module depends on.
 *
 * `enableOfflineQueue: false` is the load-bearing one. With Bun's default
 * (`true`) an outage silently accumulates every presence and typing write in
 * process memory and then replays a flood of *stale* state on reconnect — the
 * opposite of converging. Off, a command on a down connection rejects
 * immediately with `ERR_REDIS_CONNECTION_CLOSED`, which is exactly the
 * fail-fast, typed signal `command()` turns into `{ ok: false }`. It is the same
 * reasoning that leaves the server at `noeviction`: this state must fail loudly
 * rather than quietly.
 *
 * It also makes the client honestly lazy — with the queue off, a command issued
 * before `connect()` rejects instead of dialing — so importing this module can
 * never open a socket.
 */
const createBunConnection: RedisConnectionFactory = (url) =>
  new RedisClient(url, {
    enableOfflineQueue: false,
    autoReconnect: true,
    connectionTimeout: DEFAULT_CONNECTION_TIMEOUT_MS,
  }) as unknown as RedisConnection;

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

/**
 * Resolve to `undefined` rather than hang, whatever the promise does.
 *
 * Used only on the shutdown path. `close()` must terminate even when Redis is
 * unreachable, and a `quit`-style round trip against a dead socket is exactly
 * the case where an await never settles.
 */
const withTimeout = async (operation: Promise<unknown>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    // Never let the timeout itself be the reason the process stays alive.
    timer.unref?.();
  });
  try {
    await Promise.race([operation.then(() => undefined, () => undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

interface SupervisedConnection {
  role: RedisRole;
  connection: RedisConnection | undefined;
  state: RedisConnectionState;
  /** Guards against a watchdog tick starting a second attempt over the first. */
  connecting: boolean;
  /** Silences the current connection's callbacks. See `attachHandlers`. */
  detach: (() => void) | undefined;
}

export const createRedisManager = (options: CreateRedisManagerOptions): RedisManager => {
  const {
    url,
    logger = defaultLogger,
    connectionFactory = createBunConnection,
    watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    // Cast to the two-argument shape this module actually uses. The globals are
    // overloaded and lib-dependent (see `IntervalHandle`), so without this the
    // defaults widen the call signature and the handle stops matching itself.
    setIntervalFn = setInterval as (handler: () => void, ms: number) => IntervalHandle,
    clearIntervalFn = clearInterval as (handle: IntervalHandle) => void,
  } = options;

  const target = describeRedisTarget(url);
  const disabled = url === undefined;

  const initialState: RedisConnectionState = disabled ? 'disabled' : 'idle';
  const supervised: Record<RedisRole, SupervisedConnection> = {
    command: {
      role: 'command',
      connection: undefined,
      state: initialState,
      connecting: false,
      detach: undefined,
    },
    publisher: {
      role: 'publisher',
      connection: undefined,
      state: initialState,
      connecting: false,
      detach: undefined,
    },
    subscriber: {
      role: 'subscriber',
      connection: undefined,
      state: initialState,
      connecting: false,
      detach: undefined,
    },
  };

  /**
   * The channels this process intends to be subscribed to, and who wants them.
   *
   * This map — not the Redis server, and not Bun's client — is the source of
   * truth, because neither of those survives a reconnect: Bun does not re-issue
   * SUBSCRIBE and the server simply forgets a dropped connection's
   * subscriptions. Exactly one Bun subscription is held per channel and this
   * fans out to the registered handlers, so a re-subscribe is one command per
   * channel regardless of how many callers asked for it.
   */
  const channels = new Map<string, Set<RedisMessageHandler>>();

  /**
   * The one listener currently registered with the client, per channel.
   *
   * Needed because **Bun's client accumulates listeners and de-duplicates
   * nothing** — not even the same function reference. Subscribing a channel
   * twice on one connection makes every published message invoke the handler
   * twice. That matters here because `onconnect` fires again after Bun's own
   * internal reconnect, on the *same* connection object, and the replay below
   * would otherwise add a listener each time: measured against
   * `redis:8-alpine`, three transient drops took a single PUBLISH from one
   * handler call to four, while the server still reported one receiver. So the
   * previous listener is removed before a new one is registered, and this map
   * is what makes that possible. Cleared whenever a fresh connection is built,
   * which starts with no listeners of its own.
   */
  const activeListeners = new Map<string, RedisMessageHandler>();

  /**
   * Serialise every wire operation that touches one channel.
   *
   * `subscribe` and `unsubscribe` both await a round trip in the middle of
   * mutating `channels` and `activeListeners`, so without this an unsubscribe
   * that arrives while a subscribe is in flight observes bookkeeping that is
   * only half written: it finds no active listener, reports success, and the
   * subscribe then finishes and registers its listener on a channel nobody is
   * subscribed to any more. Bun accumulates listeners, so the next subscribe of
   * that channel stacks a second one and every publish is dispatched twice.
   *
   * Per channel rather than one global lock: operations on different channels
   * are independent, and a single lock would serialise an entire room's fan-out
   * behind one slow round trip.
   */
  const channelQueue = new Map<string, Promise<unknown>>();

  const onChannel = <T>(channel: string, operation: () => Promise<T>): Promise<T> => {
    const previous = channelQueue.get(channel) ?? Promise.resolve();
    // Runs on both settlements: a failed operation must not wedge the channel.
    const run = previous.then(operation, operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    channelQueue.set(channel, settled);
    void settled.then(() => {
      // Only the tail clears the entry, or a queue still being appended to
      // would be dropped by the operation that happened to finish first.
      if (channelQueue.get(channel) === settled) channelQueue.delete(channel);
    });
    return run;
  };

  /**
   * Set when the subscriber may hold a listener this module can no longer
   * account for — a removal that failed, or one it never got to attempt.
   *
   * There is no way to remove such a listener: the two-argument `unsubscribe`
   * needs the exact function reference, and the only reference is the one whose
   * removal just failed. Registering another listener for that channel would
   * therefore double every delivery. Replacing the connection is the only
   * recovery, and a fresh one starts with no listeners at all, so the watchdog
   * treats this flag the way it treats a connection that is down.
   */
  let staleSubscriber = false;

  let reconnects = 0;
  let failedCommands = 0;
  let failedPublishes = 0;
  let lastError: RedisStatus['lastError'];
  let watchdog: IntervalHandle | undefined;
  let closed = false;

  const recordError = (role: RedisRole, error: unknown): Error => {
    const normalized = toError(error);
    lastError = { role, message: normalized.message, code: errorCode(normalized) };
    return normalized;
  };

  /**
   * Log a role's state only when it actually changes.
   *
   * Every command failure during an outage would otherwise produce a line, and
   * the recent-log buffer serving the admin `/logs` endpoint holds 200 records.
   */
  const setState = (entry: SupervisedConnection, state: RedisConnectionState): void => {
    if (entry.state === state) return;
    entry.state = state;
    const details = { role: entry.role, target, state };
    if (state === 'ready') logger.info(details, `Redis ${entry.role} connection ready`);
    else if (state === 'unavailable') {
      logger.warn(
        { ...details, error: lastError?.message, code: lastError?.code },
        `Redis ${entry.role} connection unavailable; realtime fan-out is degraded`,
      );
    } else logger.debug(details, `Redis ${entry.role} connection ${state}`);
  };

  const dispatch = (channel: string): RedisMessageHandler => (message, deliveredChannel) => {
    for (const handler of channels.get(channel) ?? []) {
      try {
        handler(message, deliveredChannel);
      } catch (error) {
        // One misbehaving handler must not stop the others, and must never
        // surface as an unhandled exception out of Bun's socket callback.
        logger.error(
          { channel, error: toError(error).message },
          'Redis subscription handler threw',
        );
      }
    }
  };

  /**
   * Remove whatever listener this manager last registered for a channel.
   *
   * Reports whether the listener is now certainly gone, and gives up its
   * bookkeeping entry only when it is. Deleting the entry first — which is what
   * this did originally — makes a failed removal invisible: the caller sees
   * success, the listener is still registered on a live connection, and nothing
   * holds the reference needed to remove it later. The next subscribe of that
   * channel then stacks a second listener and every publish is dispatched
   * twice, which is exactly the failure `activeListeners` exists to prevent.
   */
  const dropListener = async (connection: RedisConnection, channel: string): Promise<boolean> => {
    const previous = activeListeners.get(channel);
    if (!previous) return true;
    try {
      await connection.unsubscribe(channel, previous);
      activeListeners.delete(channel);
      return true;
    } catch (error) {
      logger.debug(
        { channel, error: toError(error).message },
        'Failed to drop a Redis subscription listener',
      );
      return false;
    }
  };

  /** Hand the subscriber to the watchdog to be replaced. Logged once. */
  const flagStaleSubscriber = (channel: string): void => {
    if (staleSubscriber) return;
    staleSubscriber = true;
    logger.warn(
      { channel, target },
      'A Redis subscription listener could not be accounted for; the subscriber connection will be rebuilt',
    );
  };

  /**
   * Re-issue every registered channel on the subscriber connection.
   *
   * Called after *every* subscriber `onconnect`, including the first, where the
   * registry is empty and this is a no-op.
   *
   * Each channel's previous listener is removed before the new one goes on.
   * SUBSCRIBE is idempotent on the *server*, but Bun's client-side listener list
   * is not — see `activeListeners`. Skipping the removal is what turns a handful
   * of transient reconnects into every realtime event being delivered several
   * times over.
   */
  const resubscribeAll = async (connection: RedisConnection): Promise<void> => {
    for (const channel of [...channels.keys()]) {
      // Through the same per-channel queue as the public operations: a caller
      // subscribing while this replay is mid-round-trip would otherwise add its
      // own listener alongside the one being restored.
      const usableConnection = await onChannel(channel, async () => {
        // The channel may have been dropped while this replay waited its turn.
        if (!channels.has(channel)) return true;
        if (!(await dropListener(connection, channel))) {
          // The previous listener is still registered and now unreachable, so
          // restoring this channel would double every message on it. A fresh
          // connection carries none, and its own `onconnect` runs this again.
          flagStaleSubscriber(channel);
          return false;
        }
        try {
          const listener = dispatch(channel);
          await connection.subscribe(channel, listener);
          activeListeners.set(channel, listener);
        } catch (error) {
          recordError('subscriber', error);
          logger.error(
            { channel, target, error: toError(error).message },
            'Failed to restore Redis subscription after reconnect',
          );
        }
        return true;
      });
      if (!usableConnection) return;
    }
  };

  /**
   * Wire the lifecycle callbacks once, and hand back two controls over them.
   *
   * `announced()` is what stops `openRole` from re-subscribing a second time on
   * the initial connect: `onconnect` normally runs first and does the work, and
   * SUBSCRIBE-ing every channel twice per reconnect is a wasted round trip per
   * channel. It stays a fallback rather than being deleted because a `connect()`
   * that resolves without firing `onconnect` would otherwise leave a live
   * subscriber with no subscriptions at all.
   *
   * `detach()` is how a connection this manager is done with stops being able to
   * mutate its state. It sets a flag the callbacks read rather than clearing
   * `onconnect`/`onclose`, because **assigning `null` to either and then calling
   * `close()` panics Bun** — `panic(main thread): A JavaScript exception was
   * thrown, but it was cleared before it could be read`, which aborts the
   * process with SIGILL. Reproduced on 1.3.14 against `redis:8-alpine`, and
   * isolated to exactly that pair of steps: the same sequence without the null
   * assignment shuts down cleanly. Both places that retire a connection — the
   * watchdog replacing a dead one, and `close()` — therefore call this instead.
   */
  const attachHandlers = (
    entry: SupervisedConnection,
    connection: RedisConnection,
  ): { announced: () => boolean; detach: () => void } => {
    let announced = false;
    let detached = false;

    connection.onconnect = () => {
      if (detached) return;
      announced = true;
      setState(entry, 'ready');
      // The reconnect fix. Bun reports the connection healthy again but has told
      // the server nothing about our subscriptions, so without this the
      // subscriber is live and permanently deaf.
      if (entry.role === 'subscriber') void resubscribeAll(connection);
    };
    connection.onclose = (error) => {
      // Advisory only: Bun does not fire this for a drop it intends to retry, so
      // the watchdog — not this callback — is what guarantees recovery.
      if (detached || closed || entry.state === 'closed') return;
      recordError(entry.role, error);
      setState(entry, 'unavailable');
    };

    return {
      announced: () => announced,
      detach: () => {
        detached = true;
      },
    };
  };

  /**
   * Release a connection this manager is finished with.
   *
   * The unsubscribe is not optional and not only for shutdown: a Bun connection
   * closed while still in subscriber mode keeps an event-loop handle alive, and
   * the process then never exits on its own. That applies just as much to a
   * subscriber the watchdog is replacing as to one being shut down — a few
   * reconnects would otherwise be enough to wedge the next clean exit.
   *
   * Bounded, because the round trip cannot complete against a connection that is
   * already gone, and wrapped rather than awaited directly because a
   * subscriber-mode call can throw synchronously.
   */
  const retire = async (connection: RedisConnection, role: RedisRole): Promise<void> => {
    if (role === 'subscriber') {
      await withTimeout(
        Promise.resolve().then(() => connection.unsubscribe()),
        closeTimeoutMs,
      );
    }
    try {
      connection.close();
    } catch (error) {
      // Retiring reports, it does not fail. A connection that cannot be closed
      // is one that is already gone.
      logger.debug(
        { role, error: toError(error).message },
        'Ignoring error while closing Redis connection',
      );
    }
  };

  /**
   * Bring one role up, replacing whatever was there.
   *
   * A fresh connection object rather than `connect()` on the old one: a client
   * whose retry budget has run out stays dead after Redis returns, and calling
   * `connect()` on it hangs forever rather than failing, which would wedge the
   * watchdog on `entry.connecting` and stop every later attempt. Closing the old
   * handle first keeps a still-retrying client from being leaked.
   */
  const openRole = async (entry: SupervisedConnection): Promise<void> => {
    if (closed || disabled || entry.connecting || url === undefined) return;
    entry.connecting = true;

    const previous = entry.connection;
    if (previous) {
      entry.detach?.();
      entry.detach = undefined;
      // Dropped before the replacement is built, so a factory that throws
      // cannot leave the role pointing at a connection that is already closed.
      entry.connection = undefined;
      // Detached: a dead subscriber's unsubscribe can only time out, and making
      // every reconnect wait for that would stall recovery.
      void retire(previous, entry.role);
      reconnects += 1;
    }

    setState(entry, 'connecting');
    try {
      // A new connection carries none of the old one's listeners, so the map
      // that tracks them has to start empty or `resubscribeAll` would try to
      // remove listeners that live on a connection already retired.
      if (entry.role === 'subscriber') {
        activeListeners.clear();
        staleSubscriber = false;
      }

      const connection = connectionFactory(url, entry.role);
      const handlers = attachHandlers(entry, connection);
      entry.detach = handlers.detach;
      entry.connection = connection;
      await connection.connect();
      if (!handlers.announced()) {
        setState(entry, 'ready');
        if (entry.role === 'subscriber') await resubscribeAll(connection);
      }
    } catch (error) {
      recordError(entry.role, error);
      setState(entry, 'unavailable');
    } finally {
      entry.connecting = false;
    }
  };

  /**
   * The outer safety net.
   *
   * Bun's own reconnect handles the ordinary blip. This exists for the two cases
   * it cannot: a retry budget that has run out (the connection is then dead
   * forever), and a subscriber that has no traffic of its own to reveal that it
   * is down.
   */
  const tick = (): void => {
    if (closed || disabled) return;
    for (const role of REDIS_ROLES) {
      const entry = supervised[role];
      if (entry.connecting || entry.state === 'closed') continue;
      const suspect = entry.role === 'subscriber' && staleSubscriber;
      if (entry.connection?.connected && !suspect) {
        setState(entry, 'ready');
        continue;
      }
      setState(entry, 'unavailable');
      void openRole(entry);
    }
  };

  const startWatchdog = (): void => {
    if (watchdog !== undefined || closed || disabled) return;
    watchdog = setIntervalFn(tick, watchdogIntervalMs);
    // An interval that keeps the runtime alive would hold both `bun test` and a
    // shutting-down container open. `bootstrap/jobs.ts` exists for this reason.
    (watchdog as { unref?: () => void }).unref?.();
  };

  const usable = (role: RedisRole): RedisConnection | undefined => {
    const entry = supervised[role];
    return entry.connection?.connected ? entry.connection : undefined;
  };

  const unavailable = <T>(role: RedisRole, operation: string): RedisOutcome<T> => {
    const error = new Error(`Redis ${role} connection is not available for ${operation}`);
    lastError = { role, message: error.message, code: 'ERR_REDIS_UNAVAILABLE' };
    return { ok: false, error };
  };

  /**
   * Put this manager's listener for a channel on the wire.
   *
   * The single place a listener is ever registered, so the invariant that keeps
   * delivery exactly-once lives here too: never subscribe while `activeListeners`
   * still holds an entry. An entry at this point means a previous removal did
   * not complete, and Bun de-duplicates nothing — a second listener would double
   * every message on the channel. Rebuilding the connection is the only way back,
   * so this asks for that instead and reports the channel as unavailable.
   *
   * Callers must have registered the channel in `channels` first: a failure here
   * is temporary, and the registry is what the reconnect replays.
   */
  const attachListener = async (channel: string): Promise<RedisOutcome<void>> => {
    const connection = usable('subscriber');
    if (!connection) return unavailable<void>('subscriber', `SUBSCRIBE ${channel}`);
    if (activeListeners.has(channel)) {
      flagStaleSubscriber(channel);
      return unavailable<void>('subscriber', `SUBSCRIBE ${channel}`);
    }
    try {
      const listener = dispatch(channel);
      await connection.subscribe(channel, listener);
      activeListeners.set(channel, listener);
      return { ok: true as const, value: undefined };
    } catch (error) {
      return { ok: false as const, error: recordError('subscriber', error) };
    }
  };

  return {
    get status(): RedisStatus {
      return {
        target,
        ready: REDIS_ROLES.every((role) => supervised[role].connection?.connected === true),
        roles: REDIS_ROLES.map((role) => ({ role, state: supervised[role].state })),
        subscribedChannels: [...channels.keys()],
        reconnects,
        failedCommands,
        failedPublishes,
        lastError,
      };
    },

    async connect() {
      if (closed) return;
      if (disabled) {
        // Once, at boot, and never again: an operator who did not set REDIS_URL
        // needs to see that realtime is single-node, but nothing later should
        // keep saying so.
        logger.info(
          {},
          'REDIS_URL is not configured; Redis features stay disabled and realtime runs single-node',
        );
        return;
      }
      logger.info({ target }, 'Connecting to Redis');
      // Concurrently, and awaited only so a caller can order work after the
      // attempt. `openRole` already absorbs every failure, so this cannot reject
      // and must never be the reason the HTTP listener does not come up.
      await Promise.all(REDIS_ROLES.map((role) => openRole(supervised[role])));
      startWatchdog();
    },

    async command<T = unknown>(command: string, args: string[] = []) {
      const connection = usable('command');
      if (!connection) {
        failedCommands += 1;
        return unavailable<T>('command', command);
      }
      try {
        return { ok: true as const, value: (await connection.send(command, args)) as T };
      } catch (error) {
        failedCommands += 1;
        return { ok: false as const, error: recordError('command', error) };
      }
    },

    async publish(channel, message) {
      const connection = usable('publisher');
      if (!connection) {
        failedPublishes += 1;
        return unavailable<number>('publisher', `PUBLISH ${channel}`);
      }
      try {
        return { ok: true as const, value: await connection.publish(channel, message) };
      } catch (error) {
        failedPublishes += 1;
        return { ok: false as const, error: recordError('publisher', error) };
      }
    },

    async subscribe(channel, handler) {
      return onChannel(channel, async () => {
        const existing = channels.get(channel);
        if (existing) {
          existing.add(handler);
          // A registration with no listener behind it is a channel whose wire
          // SUBSCRIBE never landed — a rejected command on a connection that
          // stayed up, such as an ACL `NOPERM`, leaves exactly that. Nothing
          // retries it: the watchdog only rebuilds connections that are down,
          // and the registry already holds the channel, so every later
          // subscribe would take the branch above and report success while the
          // channel stays permanently deaf. Re-issue instead.
          if (activeListeners.has(channel)) return { ok: true as const, value: undefined };
          return attachListener(channel);
        }
        // Registered before the command is issued, so a failure here still
        // leaves the channel in the registry for the watchdog's next reconnect
        // to restore — the caller asked to be subscribed, and a down Redis is
        // temporary.
        channels.set(channel, new Set([handler]));
        return attachListener(channel);
      });
    },

    async unsubscribe(channel, handler) {
      return onChannel(channel, async () => {
        const handlers = channels.get(channel);
        if (!handlers) return { ok: true as const, value: undefined };
        handlers.delete(handler);
        if (handlers.size > 0) return { ok: true as const, value: undefined };
        channels.delete(channel);

        const connection = usable('subscriber');
        if (!connection) {
          // Nothing can be removed over a connection that is not up, and the
          // registry — which is what a reconnect replays — no longer holds the
          // channel, so the caller's intent is met. The `activeListeners` entry
          // is deliberately kept: the connection may come back up with that
          // listener still on it, and the entry is what stops a later subscribe
          // from stacking a second one. A replacement connection clears the map
          // wholesale.
          return { ok: true as const, value: undefined };
        }
        // Through the client rather than a raw `UNSUBSCRIBE` command: the raw
        // form unsubscribes the server but leaves Bun's listener in place, so a
        // later re-subscribe to the same channel would deliver every message
        // twice.
        if (await dropListener(connection, channel)) {
          return { ok: true as const, value: undefined };
        }
        flagStaleSubscriber(channel);
        return {
          ok: false as const,
          error: recordError(
            'subscriber',
            new Error(`Redis subscriber could not release ${channel}`),
          ),
        };
      });
    },

    async ping() {
      const connection = usable('command');
      if (!connection) return false;
      try {
        await connection.send('PING', []);
        return true;
      } catch (error) {
        recordError('command', error);
        return false;
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      if (disabled) return;

      if (watchdog !== undefined) {
        clearIntervalFn(watchdog);
        watchdog = undefined;
      }

      channels.clear();
      activeListeners.clear();

      for (const role of REDIS_ROLES) {
        const entry = supervised[role];
        const connection = entry.connection;
        entry.detach?.();
        entry.detach = undefined;
        entry.connection = undefined;
        entry.state = 'closed';
        if (!connection) continue;
        await retire(connection, role);
      }

      logger.info({ target, reconnects, failedCommands, failedPublishes }, 'Redis connections closed');
    },
  };
};
