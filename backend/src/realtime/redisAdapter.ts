import { ClusterAdapter, MessageType } from 'socket.io-adapter';
import type { ClusterMessage, ClusterResponse, Offset, ServerId } from 'socket.io-adapter';
import type { Namespace, ServerOptions } from 'socket.io';
import type pino from 'pino';
import type { RedisManager, RedisMessageHandler } from '../utils/redis';
import { logger as defaultLogger } from '../utils/logger';

/**
 * The Redis channel every backend instance exchanges realtime frames on.
 *
 * One channel for the whole cluster rather than one per room: Bun's native
 * Redis client has no `PSUBSCRIBE` (`bun-types/redis.d.ts` declares only
 * `subscribe(channel | channels, listener)`), so a per-room channel scheme
 * would mean a wire subscription per room and a resubscribe storm on every
 * join. A single channel costs each instance the frames addressed to rooms it
 * holds no sockets for, which `Adapter#broadcast` discards locally anyway.
 */
export const REALTIME_CHANNEL = 'near-chat-ws';

/**
 * Cross-instance realtime fan-out, as a Socket.IO cluster adapter.
 *
 * Every `io.to(...).emit(...)`, `socketsJoin`, `socketsLeave` and
 * `disconnectSockets` in this codebase already routes through the namespace
 * adapter; the in-memory default simply stops at the process boundary. This
 * subclass carries those same operations to the other instances, so nothing
 * above it — `realtime/publisher.ts`, the services, `socketServer.ts` — has to
 * know that more than one instance exists.
 *
 * The frame on the wire is Socket.IO's own `ClusterMessage`, JSON encoded.
 * Reusing it rather than inventing an envelope is deliberate: it already
 * carries the event, the target rooms, the excluded sockets, the payload and
 * the originating server id, and a second format would be a payload contract
 * to keep in step with Socket.IO's forever.
 *
 * Delivery is at most once, and deliberately so. Redis pub/sub keeps no
 * backlog: a frame published while an instance's subscriber is down is gone,
 * and `RedisManager` replays the *subscription* on reconnect, not the frames
 * missed while it was away. That is the same guarantee the official Redis
 * adapter gives, and the reason clients recover through their Sync Cursor
 * rather than by trusting the socket.
 *
 * A Redis outage degrades rather than fails: `ClusterAdapter#broadcast`
 * publishes inside a `try`/`catch` and calls `super.broadcast` regardless, so
 * local delivery is unaffected and the process never sees a rejection.
 */
export interface RedisAdapterDeps {
  redis: RedisManager;
  /** This process's identity, the same one that names its presence leases. */
  instanceId: string;
  logger?: pino.Logger;
}

/** The fields a frame must carry before the base class may be handed it. */
interface ClusterFrame {
  uid: ServerId;
  nsp: string;
  type: MessageType;
}

const KNOWN_MESSAGE_TYPES: ReadonlySet<number> = new Set(
  Object.values(MessageType).filter((value): value is MessageType => typeof value === 'number'),
);

/**
 * Narrows an already-parsed frame.
 *
 * Only the three routing fields are checked. The per-type `data` shape is left
 * to the base class, which reads it through the same `MessageType` switch that
 * produced it — restating that union here would be a second copy of Socket.IO's
 * contract, which is the thing this module exists to avoid.
 */
const isClusterFrame = (value: unknown): value is ClusterFrame => {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    typeof frame.uid === 'string' &&
    typeof frame.nsp === 'string' &&
    typeof frame.type === 'number' &&
    KNOWN_MESSAGE_TYPES.has(frame.type)
  );
};

/**
 * Plain `ClusterAdapter`, not `ClusterAdapterWithHeartbeat`.
 *
 * The heartbeat subclass exists to keep `serverCount()` accurate for
 * `fetchSockets` and `serverSideEmit`, neither of which this codebase calls. It
 * would cost a 1s `setInterval` opened in its constructor and cleared only by
 * `close()` — and `close()` never runs here, because shutdown goes through
 * `server.close()` in `index.ts` and never calls `io.close()`. Since
 * `bootstrap/realtime.ts` is evaluated at import time, that timer would be left
 * running by every process that merely imports the app, the E2E suite included.
 */
class RedisClusterAdapter extends ClusterAdapter {
  readonly #redis: RedisManager;
  readonly #instanceId: string;
  readonly #logger: pino.Logger;
  #listener: RedisMessageHandler | undefined;
  /** Frames dropped before reaching the base class, logged once then counted. */
  #rejected = 0;

  constructor(nsp: Namespace, { redis, instanceId, logger = defaultLogger }: RedisAdapterDeps) {
    super(nsp);
    this.#redis = redis;
    this.#instanceId = instanceId;
    this.#logger = logger;
  }

  override async init(): Promise<void> {
    const listener: RedisMessageHandler = (message) => this.#receive(message);
    this.#listener = listener;
    const result = await this.#redis.subscribe(REALTIME_CHANNEL, listener);
    if (!result.ok) {
      // Not fatal, and not retried here: the manager's watchdog owns
      // reconnection and replays this channel once Redis answers again.
      this.#logger.warn(
        { channel: REALTIME_CHANNEL, error: result.error.message, instanceId: this.#instanceId },
        'Realtime cluster adapter could not subscribe yet; fan-out stays local until Redis is reachable',
      );
      return;
    }
    // Logged once per namespace so an operator can tie a server id seen in a
    // frame back to the instance that produced it. The two identities are
    // separate on purpose: `uid` is Socket.IO's, minted per adapter, while
    // `instanceId` is this process's and also names its presence leases.
    this.#logger.info(
      { channel: REALTIME_CHANNEL, instanceId: this.#instanceId, adapterUid: this.uid, nsp: this.nsp.name },
      'Realtime cluster adapter subscribed',
    );
  }

  override async close(): Promise<void> {
    const listener = this.#listener;
    if (!listener) return;
    this.#listener = undefined;
    await this.#redis.unsubscribe(REALTIME_CHANNEL, listener);
  }

  /**
   * The offset is Socket.IO's connection-state-recovery cursor, and
   * `addOffsetIfNecessary` reads it only when `connectionStateRecovery` is
   * configured on the server. It is not, and by ADR it stays off — recovery
   * here is the Sync Cursor, not a replayed socket buffer — so there is no
   * stream position to report and inventing a counter would imply a durability
   * this transport does not have.
   */
  protected async doPublish(message: ClusterMessage): Promise<Offset> {
    await this.#send(message);
    return '';
  }

  /**
   * Responses ride the same channel as requests rather than a per-requester
   * one. Every instance therefore sees them, and every instance but the
   * requester drops them: `onResponse` looks the `requestId` up in its own
   * pending map and returns when it is absent. Nothing in this codebase calls
   * `fetchSockets` or `serverSideEmit`, so the path carries no traffic at all
   * today; a second channel would be a second subscription to keep alive for it.
   */
  protected async doPublishResponse(_requesterUid: ServerId, response: ClusterResponse): Promise<void> {
    await this.#send(response);
  }

  async #send(frame: ClusterMessage | ClusterResponse): Promise<void> {
    const result = await this.#redis.publish(REALTIME_CHANNEL, JSON.stringify(frame));
    if (result.ok) return;
    // Thrown rather than swallowed: `ClusterAdapter` already catches around
    // every call site — `broadcast` falls through to local delivery, `publish`
    // and `publishResponse` attach their own `catch` — and letting it surface
    // keeps that accounting in one place instead of two.
    throw result.error;
  }

  /**
   * Decode one frame from the channel.
   *
   * Only the checks the base class does not make are made here: that the frame
   * is JSON at all, and that it carries the three fields `onMessage` routes on.
   * A frame that passes and then lies about its `data` still throws inside the
   * base `switch` — the per-type shapes are Socket.IO's contract and restating
   * them here would be the second copy this module exists to avoid — but
   * `RedisManager` isolates a throwing handler, so the cost is one logged error
   * rather than a dead subscriber.
   *
   * This instance's own echo and another namespace's traffic are deliberately
   * *not* filtered here: `ClusterAdapter#onMessage` drops both before touching
   * any state, and they are ordinary traffic on a shared channel rather than
   * anomalies worth counting.
   */
  #receive(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#reject('unparsable');
      return;
    }
    if (!isClusterFrame(parsed)) {
      this.#reject('unrecognised');
      return;
    }
    this.onMessage(parsed as ClusterMessage);
  }

  /**
   * Frames arrive as fast as the cluster produces them, so a malformed
   * publisher must not be able to write one log line per event. The first is
   * worth an operator's attention; after that only the count is, and it is
   * reported on the line that carries it.
   */
  #reject(reason: string): void {
    this.#rejected += 1;
    // Never the frame body: these carry message content.
    const details = { channel: REALTIME_CHANNEL, reason, rejected: this.#rejected };
    if (this.#rejected === 1) {
      this.#logger.warn(details, 'Dropped a realtime cluster frame');
    } else {
      this.#logger.debug(details, 'Dropped a realtime cluster frame');
    }
  }
}

/**
 * Builds the `adapter` option for the Socket.IO server.
 *
 * A class rather than a factory function, despite `AdapterConstructor`
 * admitting both: `Namespace#_initAdapter` reaches the stored value through
 * `new (this.server.adapter())(this)`, so only the constructor arm is real at
 * runtime. Closing over the dependencies in a subclass is what keeps them
 * injectable — Socket.IO builds one adapter per namespace and passes nothing
 * but the namespace, so there is no other seam to reach them through, and a
 * module-level singleton would put this module's Redis handle beyond the reach
 * of a test.
 */
export const createRedisAdapter = (deps: RedisAdapterDeps): ServerOptions['adapter'] =>
  class RedisAdapter extends RedisClusterAdapter {
    constructor(nsp: Namespace) {
      super(nsp, deps);
    }
  };
