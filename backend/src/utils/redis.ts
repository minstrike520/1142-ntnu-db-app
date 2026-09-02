import { RedisClient } from 'bun';
import type pino from 'pino';
import { describeRedisTarget } from './describeRedisTarget';
import { logger as defaultLogger } from './logger';

/**
 * Redis connection and lifecycle manager.
 *
 * Manages three dedicated Bun Redis connections:
 * - subscriber: Handles pub/sub subscriptions (only accepts subscribe, ping, quit).
 * - publisher: Broadcasts realtime events.
 * - command: Standard key-value operations (presence, leases, TTLs).
 *
 * Handles Bun Redis driver nuances:
 * - Re-subscribes to channels on reconnect.
 * - Monitors connection liveness with a watchdog timer.
 * - Unsubscribes before closing to cleanly release event loop handles.
 * - Replaces dead clients when native retries are exhausted.
 */

/** Callback shape Bun hands a subscription listener. */
export type RedisMessageHandler = (message: string, channel: string) => void;

export type RedisRole = 'command' | 'publisher' | 'subscriber';

export const REDIS_ROLES: readonly RedisRole[] = ['command', 'publisher', 'subscriber'];

/** Watchdog interval to check and recover dropped connections. */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000;

/** Max time allowed for closing Redis connections during shutdown. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

/** Connection timeout passed to the Redis client. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Result pattern for operations that can degrade without throwing.
 * ok: true means Redis accepted the command.
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

/** Operational status for health checks, admin metrics, and diagnostics. */
export interface RedisStatus {
  /** Log-safe `host:port/db`; never the raw URL containing credentials. */
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

/** Seam interface for the Bun RedisClient used by this module. */
export interface RedisConnection {
  readonly connected: boolean;
  onconnect: (() => void) | null;
  onclose: ((error: Error) => void) | null;
  connect(): Promise<unknown>;
  close(): void;
  send(command: string, args: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: RedisMessageHandler): Promise<number>;
  /** Leave every channel, which also clears subscriber mode. */
  unsubscribe(): Promise<void>;
  /** Drop one specific listener. */
  unsubscribe(channel: string, listener: RedisMessageHandler): Promise<void>;
}

export type RedisConnectionFactory = (url: string, role: RedisRole) => RedisConnection;

/** Timer handle type across DOM, Node, and Bun runtimes. */
export type IntervalHandle = ReturnType<typeof setInterval> | number;

export interface RedisManager {
  readonly status: RedisStatus;
  /** Opens all role connections. Does not reject on failure. */
  connect(): Promise<void>;
  /** Any Redis command, by name. Uses the command connection. */
  command<T = unknown>(command: string, args?: string[]): Promise<RedisOutcome<T>>;
  /** Broadcasts a message using the publisher connection. */
  publish(channel: string, message: string): Promise<RedisOutcome<number>>;
  /** Registers a handler and subscribes if this is the channel's first handler. */
  subscribe(channel: string, handler: RedisMessageHandler): Promise<RedisOutcome<void>>;
  /** Drops one handler, unsubscribing from Redis once no handlers remain. */
  unsubscribe(channel: string, handler: RedisMessageHandler): Promise<RedisOutcome<void>>;
  /** Pings the command connection to verify liveness. Returns false if down. */
  ping(): Promise<boolean>;
  /** Closes all connections and stops watchdog. Idempotent and never rejects. */
  close(): Promise<void>;
}

export interface CreateRedisManagerOptions {
  /** Resolved by config/env.ts; undefined runs in single-node mode without Redis. */
  url: string | undefined;
  logger?: pino.Logger;
  /** Injectable factory for unit testing without sockets. */
  connectionFactory?: RedisConnectionFactory;
  watchdogIntervalMs?: number;
  closeTimeoutMs?: number;
  /** Injectable timer functions for testing. */
  setIntervalFn?: (handler: () => void, ms: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
}

/**
 * Creates a Bun Redis client with disabled offline queue to fail fast
 * rather than queueing stale operations during outages.
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

/** Resolves or times out to prevent hangs during shutdown. */
const withTimeout = async (operation: Promise<unknown>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
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
  /** True while a connection attempt is in flight. */
  connecting: boolean;
  /** Silences callbacks when connection is retired. */
  detach: (() => void) | undefined;
}

export const createRedisManager = (options: CreateRedisManagerOptions): RedisManager => {
  const {
    url,
    logger = defaultLogger,
    connectionFactory = createBunConnection,
    watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
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

  /** Maps subscribed channels to their registered message handlers. */
  const channels = new Map<string, Set<RedisMessageHandler>>();

  /** Tracks active client-level listener per channel to prevent duplicate subscriptions. */
  const activeListeners = new Map<string, RedisMessageHandler>();

  /** Serializes operations per channel to prevent subscription race conditions. */
  const channelQueue = new Map<string, Promise<unknown>>();

  const onChannel = <T>(channel: string, operation: () => Promise<T>): Promise<T> => {
    const previous = channelQueue.get(channel) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    channelQueue.set(channel, settled);
    void settled.then(() => {
      if (channelQueue.get(channel) === settled) channelQueue.delete(channel);
    });
    return run;
  };

  /** Flag indicating subscriber has untracked listeners and must be rebuilt. */
  let staleSubscriber = false;

  /** True while re-subscribing channels during reconnect. */
  let replaying = false;

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

  /** Logs connection state transitions (suppresses duplicate logs when state is unchanged). */
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

  /** Dispatches incoming messages to all registered handlers for a channel. */
  const dispatch = (channel: string): RedisMessageHandler => (message, deliveredChannel) => {
    for (const handler of channels.get(channel) ?? []) {
      try {
        handler(message, deliveredChannel);
      } catch (error) {
        logger.error(
          { channel, error: toError(error).message },
          'Redis subscription handler threw',
        );
      }
    }
  };

  /** Removes the active listener for a channel from the client. */
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

  /** Marks subscriber connection as stale so the watchdog replaces it. */
  const flagStaleSubscriber = (channel: string): void => {
    if (staleSubscriber) return;
    staleSubscriber = true;
    logger.warn(
      { channel, target },
      'A Redis subscription listener could not be accounted for; the subscriber connection will be rebuilt',
    );
  };

  /** Re-subscribes all registered channels on the subscriber connection. */
  const resubscribeAll = async (connection: RedisConnection): Promise<void> => {
    replaying = true;
    try {
      await replayChannels(connection);
    } finally {
      replaying = false;
    }
  };

  const replayChannels = async (connection: RedisConnection): Promise<void> => {
    for (const channel of [...channels.keys()]) {
      const usableConnection = await onChannel(channel, async () => {
        if (!channels.has(channel)) return true;
        if (!(await dropListener(connection, channel))) {
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

  /** Hooks lifecycle callbacks to track connection state and trigger resubscription. */
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
      if (entry.role === 'subscriber') void resubscribeAll(connection);
    };
    connection.onclose = (error) => {
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

  /** Gracefully unsubscribes and closes a retired connection. */
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
      logger.debug(
        { role, error: toError(error).message },
        'Ignoring error while closing Redis connection',
      );
    }
  };

  /** Establishes a new connection for a specific role. */
  const openRole = async (entry: SupervisedConnection): Promise<void> => {
    if (closed || disabled || entry.connecting || url === undefined) return;
    entry.connecting = true;

    const previous = entry.connection;
    if (previous) {
      entry.detach?.();
      entry.detach = undefined;
      entry.connection = undefined;
      void retire(previous, entry.role);
      reconnects += 1;
    }

    setState(entry, 'connecting');
    try {
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

  /** Periodic check to recover dropped connections and sync missed subscriptions. */
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

    // Restore any registered channels that lack active listeners.
    const subscriber = supervised.subscriber;
    if (staleSubscriber || replaying || subscriber.connecting) return;
    if (!subscriber.connection?.connected) return;
    for (const channel of channels.keys()) {
      if (activeListeners.has(channel)) continue;
      if (channelQueue.has(channel)) continue;
      void onChannel(channel, () => attachListener(channel)).catch(() => undefined);
    }
  };

  const startWatchdog = (): void => {
    if (watchdog !== undefined || closed || disabled) return;
    watchdog = setIntervalFn(tick, watchdogIntervalMs);
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

  /** Subscribes to a channel on the subscriber connection and registers listener. */
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
        logger.info(
          {},
          'REDIS_URL is not configured; Redis features stay disabled and realtime runs single-node',
        );
        return;
      }
      logger.info({ target }, 'Connecting to Redis');
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
          if (activeListeners.has(channel)) return { ok: true as const, value: undefined };
          return attachListener(channel);
        }
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
          return { ok: true as const, value: undefined };
        }
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
