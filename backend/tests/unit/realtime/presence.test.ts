import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { createPresenceTracker, type PresenceTracker } from '../../../src/realtime/presence';
import type { PresenceStore } from '../../../src/realtime/presenceStore';
import type { RedisOutcome } from '../../../src/utils/redis';
import type { ChatServer } from '../../../src/realtime/authSocket';

/**
 * One shared lease table, viewed through as many instances as a test needs.
 *
 * Modelled as intentions rather than as Redis commands, which is the point of
 * the `PresenceStore` seam: the fake has to be faithful about *who holds a
 * lease*, and nothing else. Expiry, hash-field TTLs and the atomicity of the
 * transitions are Redis's semantics, and they are pinned against a real server
 * in `tests/integration/realtime/presenceStore.test.ts` rather than guessed at
 * here.
 */
const makeSharedLeases = () => {
  const holders = new Map<string, Set<string>>();
  let failing = false;

  const down = <T>(): RedisOutcome<T> => ({ ok: false, error: new Error('redis unavailable') });

  const viewFor = (instanceId: string): PresenceStore => ({
    async hold(userId) {
      if (failing) return down<number>();
      const set = holders.get(userId) ?? new Set<string>();
      const before = set.size;
      set.add(instanceId);
      holders.set(userId, set);
      return { ok: true, value: before };
    },
    async release(userId) {
      if (failing) return down<number>();
      const set = holders.get(userId);
      if (!set) return { ok: true, value: 0 };
      set.delete(instanceId);
      if (set.size === 0) holders.delete(userId);
      return { ok: true, value: set.size };
    },
    async isOnline(userId) {
      if (failing) return down<boolean>();
      return { ok: true, value: (holders.get(userId)?.size ?? 0) > 0 };
    },
    async areOnline(userIds) {
      if (failing) return down<Set<string>>();
      return {
        ok: true,
        value: new Set(userIds.filter((id) => (holders.get(id)?.size ?? 0) > 0)),
      };
    },
    async onlineUsers() {
      if (failing) return down<string[]>();
      return { ok: true, value: [...holders.keys()] };
    },
  });

  return {
    holders,
    viewFor,
    breakRedis: () => {
      failing = true;
    },
    healRedis: () => {
      failing = false;
    },
  };
};

const makeIo = () => {
  const roomEmit = mock();
  const io = { to: mock(() => ({ emit: roomEmit })) } as unknown as ChatServer;
  return { io, roomEmit };
};

describe('presence tracker', () => {
  let io: ChatServer;
  let roomEmit: ReturnType<typeof mock>;
  let friendRepo: { getFriends: ReturnType<typeof mock> };
  let tracker: PresenceTracker;

  beforeEach(() => {
    ({ io, roomEmit } = makeIo());
    friendRepo = {
      getFriends: mock().mockResolvedValue([
        { friend: { userId: 'friend-1' } },
        { friend: { userId: 'friend-2' } },
      ]),
    };
    tracker = createPresenceTracker({ graceMs: () => 0 });
  });

  describe('without a store (single node)', () => {
    it('tracks connection, reports online status, and notifies online friends', async () => {
      expect(await tracker.isUserOnline('user-1')).toBe(false);

      await tracker.trackUserConnection(io, 'friend-1', 'socket-friend', friendRepo);
      expect(await tracker.isUserOnline('friend-1')).toBe(true);

      await tracker.trackUserConnection(io, 'user-1', 'socket-1', friendRepo);
      expect(await tracker.isUserOnline('user-1')).toBe(true);
      expect(await tracker.getOnlineUsers()).toContain('user-1');

      // Both friends are addressed in one broadcast, friend-2 included: whether
      // a session exists for a room is the adapter's question, not this
      // module's, and answering it here is what used to lose the friends
      // connected to another instance.
      expect(io.to).toHaveBeenCalledWith(['user_friend-1', 'user_friend-2']);
      expect(roomEmit).toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'online' });
    });

    it('handles trackUserDisconnection gracefully when userId was never tracked', async () => {
      await expect(
        tracker.trackUserDisconnection(io, 'unknown-user', 'socket-1', friendRepo),
      ).resolves.toBeUndefined();
    });

    it('suppresses and logs errors from getFriends during trackUserConnection', async () => {
      const errorRepo = { getFriends: mock().mockRejectedValue(new Error('DB down')) };
      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        tracker.trackUserConnection(io, 'user-x', 'socket-1', errorRepo),
      ).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('suppresses and logs errors from getFriends during trackUserDisconnection', async () => {
      await tracker.trackUserConnection(io, 'user-y', 'socket-1', friendRepo);
      const errorRepo = { getFriends: mock().mockRejectedValue(new Error('DB down')) };
      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        tracker.trackUserDisconnection(io, 'user-y', 'socket-1', errorRepo),
      ).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('handles multiple socket connections per user and tracks disconnection', async () => {
      await tracker.trackUserConnection(io, 'user-1', 'socket-tab-1', friendRepo);
      await tracker.trackUserConnection(io, 'user-1', 'socket-tab-2', friendRepo);

      expect(await tracker.isUserOnline('user-1')).toBe(true);

      await tracker.trackUserDisconnection(io, 'user-1', 'socket-tab-1', friendRepo);
      expect(await tracker.isUserOnline('user-1')).toBe(true);
      expect(roomEmit).not.toHaveBeenCalledWith('user_status', {
        userId: 'user-1',
        status: 'offline',
      });

      await tracker.trackUserConnection(io, 'friend-1', 'socket-friend', friendRepo);
      roomEmit.mockClear();

      await tracker.trackUserDisconnection(io, 'user-1', 'socket-tab-2', friendRepo);
      expect(await tracker.isUserOnline('user-1')).toBe(false);
      expect(io.to).toHaveBeenCalledWith(['user_friend-1', 'user_friend-2']);
      expect(roomEmit).toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'offline' });
    });

    it('answers offline rather than unknown, because one process is the whole deployment', async () => {
      expect(await tracker.presenceOf('nobody')).toBe('offline');
    });
  });

  describe('across instances', () => {
    let leases: ReturnType<typeof makeSharedLeases>;
    let alpha: PresenceTracker;
    let beta: PresenceTracker;
    let betaIo: ChatServer;
    let betaEmit: ReturnType<typeof mock>;

    beforeEach(() => {
      leases = makeSharedLeases();
      alpha = createPresenceTracker({ store: leases.viewFor('alpha'), graceMs: () => 0 });
      const second = makeIo();
      betaIo = second.io;
      betaEmit = second.roomEmit;
      beta = createPresenceTracker({ store: leases.viewFor('beta'), graceMs: () => 0 });
    });

    /**
     * Seats the same friend on both instances.
     *
     * `broadcastStatus` no longer asks who is reachable — it addresses every
     * friend's room and lets the adapter deliver (#476) — so this is no longer
     * what makes the transitions observable. It stays because the transitions
     * under test here are about *which instance announces them*, and a friend
     * present on both keeps that question separate from where the audience sits.
     */
    const seatAudience = async () => {
      await alpha.trackUserConnection(io, 'friend-1', 'socket-f-a', friendRepo);
      await beta.trackUserConnection(betaIo, 'friend-1', 'socket-f-b', friendRepo);
      roomEmit.mockClear();
      betaEmit.mockClear();
    };

    it('announces online only for the first connection anywhere', async () => {
      await seatAudience();

      await alpha.trackUserConnection(io, 'user-1', 'socket-a', friendRepo);
      expect(roomEmit).toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'online' });

      // The same user arriving on a second instance is not a new arrival.
      await beta.trackUserConnection(betaIo, 'user-1', 'socket-b', friendRepo);
      expect(betaEmit).not.toHaveBeenCalledWith('user_status', {
        userId: 'user-1',
        status: 'online',
      });
    });

    it('does not announce offline while another instance still holds a connection', async () => {
      await seatAudience();
      await alpha.trackUserConnection(io, 'user-1', 'socket-a', friendRepo);
      await beta.trackUserConnection(betaIo, 'user-1', 'socket-b', friendRepo);
      roomEmit.mockClear();
      betaEmit.mockClear();

      await alpha.trackUserDisconnection(io, 'user-1', 'socket-a', friendRepo);
      expect(roomEmit).not.toHaveBeenCalledWith('user_status', {
        userId: 'user-1',
        status: 'offline',
      });
      // ...and the instance that lost the socket still reports the user online,
      // because the other one answered for them.
      expect(await alpha.isUserOnline('user-1')).toBe(true);

      await beta.trackUserDisconnection(betaIo, 'user-1', 'socket-b', friendRepo);
      expect(betaEmit).toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'offline' });
      expect(await alpha.isUserOnline('user-1')).toBe(false);
    });

    it('reports a user connected elsewhere as online', async () => {
      await beta.trackUserConnection(betaIo, 'user-1', 'socket-b', friendRepo);
      expect(await alpha.isUserOnline('user-1')).toBe(true);
      expect(await alpha.getOnlineUsers()).toContain('user-1');
    });

    /**
     * The defect #476 names: the friend's only session is on the *other*
     * instance, which is the one case the old `isLocallyOnline` gate could not
     * see. It emitted nothing at all, so the adapter had nothing to carry and
     * the friend learned of the change only on their next `GET /friends`.
     */
    it('announces to a friend whose only session is on another instance', async () => {
      // Deliberately nobody on alpha: no local socket for either friend.
      await beta.trackUserConnection(betaIo, 'friend-1', 'socket-f-b', friendRepo);
      roomEmit.mockClear();
      betaEmit.mockClear();

      await alpha.trackUserConnection(io, 'user-1', 'socket-a', friendRepo);

      expect(io.to).toHaveBeenCalledWith(['user_friend-1', 'user_friend-2']);
      expect(roomEmit).toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'online' });

      roomEmit.mockClear();
      await alpha.trackUserDisconnection(io, 'user-1', 'socket-a', friendRepo);
      expect(roomEmit).toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'offline' });
    });

    /**
     * `Adapter#apply` reads an empty room set as the whole namespace, so an
     * unguarded `io.to([])` would broadcast a friendless user's presence to
     * every connected client in the cluster. The guard is the only thing
     * standing between this change and that, so it is pinned here.
     */
    it('says nothing at all for a user with no friends', async () => {
      const friendless = { getFriends: mock().mockResolvedValue([]) };

      await alpha.trackUserConnection(io, 'loner', 'socket-a', friendless);
      await alpha.trackUserDisconnection(io, 'loner', 'socket-a', friendless);

      expect(io.to).not.toHaveBeenCalled();
      expect(roomEmit).not.toHaveBeenCalled();
    });

    /**
     * The push no longer consults Redis, so the window where the command
     * connection is down while the publisher carrying the frame is healthy —
     * two independently supervised connections — no longer costs every remote
     * friend their notification.
     */
    it('still announces when the presence store cannot be reached', async () => {
      await beta.trackUserConnection(betaIo, 'friend-1', 'socket-f-b', friendRepo);
      await alpha.trackUserConnection(io, 'user-1', 'socket-a', friendRepo);
      roomEmit.mockClear();
      leases.breakRedis();

      await alpha.trackUserDisconnection(io, 'user-1', 'socket-a', friendRepo);

      expect(io.to).toHaveBeenCalledWith(['user_friend-1', 'user_friend-2']);
      expect(roomEmit).toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'offline' });
    });

    it('resolves a whole page of users in one read', async () => {
      await beta.trackUserConnection(betaIo, 'user-1', 'socket-b', friendRepo);
      await alpha.trackUserConnection(io, 'user-2', 'socket-a', friendRepo);

      const online = await alpha.onlineAmong(['user-1', 'user-2', 'user-3']);
      expect([...online].sort()).toEqual(['user-1', 'user-2']);
    });

    it('holds the lease through the reconnect grace period, wherever the reconnect lands', async () => {
      const gracefulAlpha = createPresenceTracker({
        store: leases.viewFor('alpha'),
        graceMs: () => 50,
      });
      await gracefulAlpha.trackUserConnection(io, 'user-1', 'socket-a', friendRepo);
      roomEmit.mockClear();

      await gracefulAlpha.trackUserDisconnection(io, 'user-1', 'socket-a', friendRepo);
      // Still leased: another instance must not see a gap during the grace window.
      expect(await beta.isUserOnline('user-1')).toBe(true);

      // The reconnect lands on the *other* instance, which is exactly the case a
      // local grace timer cannot see.
      await beta.trackUserConnection(betaIo, 'user-1', 'socket-b', friendRepo);
      expect(betaEmit).not.toHaveBeenCalledWith('user_status', {
        userId: 'user-1',
        status: 'online',
      });

      await new Promise((resolve) => setTimeout(resolve, 80));
      // The grace timer fired on alpha and dropped alpha's lease — but beta is
      // holding one, so nobody was told the user went offline.
      expect(roomEmit).not.toHaveBeenCalledWith('user_status', {
        userId: 'user-1',
        status: 'offline',
      });
      expect(await beta.isUserOnline('user-1')).toBe(true);
    });

    it('hands leases back on shutdown instead of waiting out the TTL', async () => {
      await alpha.trackUserConnection(io, 'user-1', 'socket-a', friendRepo);
      expect(leases.holders.get('user-1')?.has('alpha')).toBe(true);

      await alpha.stop();
      expect(leases.holders.has('user-1')).toBe(false);
    });
  });

  describe('when Redis is unreachable', () => {
    let leases: ReturnType<typeof makeSharedLeases>;

    beforeEach(() => {
      leases = makeSharedLeases();
      tracker = createPresenceTracker({ store: leases.viewFor('alpha'), graceMs: () => 0 });
    });

    it('still tracks connections and announces the local edges', async () => {
      await tracker.trackUserConnection(io, 'friend-1', 'socket-friend', friendRepo);
      roomEmit.mockClear();
      leases.breakRedis();

      await expect(
        tracker.trackUserConnection(io, 'user-1', 'socket-1', friendRepo),
      ).resolves.toBeUndefined();
      expect(roomEmit).toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'online' });

      roomEmit.mockClear();
      await tracker.trackUserDisconnection(io, 'user-1', 'socket-1', friendRepo);
      expect(roomEmit).toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'offline' });
    });

    it('says "unknown" rather than "offline" for a user it cannot ask about', async () => {
      leases.breakRedis();
      expect(await tracker.presenceOf('someone-elsewhere')).toBe('unknown');
      // The display collapse is still offline — a screen has to show something.
      expect(await tracker.isUserOnline('someone-elsewhere')).toBe(false);
    });

    it('never says "unknown" about a user connected to this instance', async () => {
      await tracker.trackUserConnection(io, 'user-1', 'socket-1', friendRepo);
      leases.breakRedis();
      expect(await tracker.presenceOf('user-1')).toBe('online');
    });
  });

  describe('lease heartbeat', () => {
    it('re-takes every lease it holds, so a live connection outlives the TTL', async () => {
      const leases = makeSharedLeases();
      let beat: (() => void) | undefined;
      const heartbeatTracker = createPresenceTracker({
        store: leases.viewFor('alpha'),
        graceMs: () => 0,
        ttlMs: 300,
        refreshDivisor: 3,
        setIntervalFn: (handler) => {
          beat = handler;
          return 0;
        },
        clearIntervalFn: () => {},
      });

      await heartbeatTracker.trackUserConnection(io, 'user-1', 'socket-1', friendRepo);
      expect(beat).toBeDefined();

      // Something else expired the lease — a Redis restart, a TTL that elapsed
      // during an outage. The next beat must put it back.
      leases.holders.delete('user-1');
      beat!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(leases.holders.get('user-1')?.has('alpha')).toBe(true);
    });

    it('does not re-take a lease for a user who has already left', async () => {
      const leases = makeSharedLeases();
      let beat: (() => void) | undefined;
      const heartbeatTracker = createPresenceTracker({
        store: leases.viewFor('alpha'),
        graceMs: () => 0,
        ttlMs: 300,
        setIntervalFn: (handler) => {
          beat = handler;
          return 0;
        },
        clearIntervalFn: () => {},
      });

      await heartbeatTracker.trackUserConnection(io, 'user-1', 'socket-1', friendRepo);
      await heartbeatTracker.trackUserDisconnection(io, 'user-1', 'socket-1', friendRepo);
      expect(leases.holders.has('user-1')).toBe(false);

      beat!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(leases.holders.has('user-1')).toBe(false);
    });

    it('starts no timer at all without a store', async () => {
      const setIntervalFn = mock(() => 0);
      const local = createPresenceTracker({ graceMs: () => 0, setIntervalFn });
      await local.trackUserConnection(io, 'user-1', 'socket-1', friendRepo);
      expect(setIntervalFn).not.toHaveBeenCalled();
    });
  });
});
