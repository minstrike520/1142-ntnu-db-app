import { describe, it, expect, beforeEach, mock, type Mock } from 'bun:test';
import { attachSockets } from '../../../src/realtime/socketServer';
import type { ChatServer } from '../../../src/realtime/authSocket';

// Injected rather than `mock.module`'d: a module mock is process-global within
// a tier and cannot be undone, so stubbing presence here would also stub it for
// every later file in this tier. See backend/tests/CLAUDE.md and issue #467.
const presence = {
  trackUserConnection: mock().mockResolvedValue(undefined),
  trackUserDisconnection: mock().mockResolvedValue(undefined),
};

describe('attachSockets', () => {
  let connectionHandler: any;
  let handlers: Record<string, any>;
  let socket: any;
  let roomEmit: Mock<any>;
  let roomMemberRepo: {
    findByUser: Mock<any>;
    findMember: Mock<any>;
  };

  beforeEach(() => {
    handlers = {};
    roomEmit = mock();
    socket = {
      id: 'socket-1',
      data: { user: { userId: 'user-1', name: 'Alice' } },
      // A real Socket.IO socket tracks its rooms, and the typing handler reads
      // them to decide whether its cached membership check is still good.
      rooms: new Set(['user_user-1', 'room_room-active']),
      join: mock(),
      leave: mock(),
      emit: mock(),
      to: mock(() => ({ emit: roomEmit })),
      on: mock((event, handler) => {
        handlers[event] = handler;
      }),
    };
    roomMemberRepo = {
      findByUser: mock().mockResolvedValue([
        { roomId: 'room-active', role: 'member' },
        { roomId: 'room-pending', role: 'pending' },
      ]),
      findMember: mock().mockResolvedValue({ roomId: 'room-active', role: 'member' }),
    };

    const io = {
      on: mock((event, handler) => {
        if (event === 'connection') connectionHandler = handler;
      }),
      to: mock(() => ({ emit: roomEmit })),
    } as unknown as ChatServer;

    attachSockets(io, { roomMemberRepository: roomMemberRepo });
    connectionHandler(socket);
  });

  it('derives room subscriptions from active durable membership', async () => {
    await Promise.resolve();

    expect(roomMemberRepo.findByUser).toHaveBeenCalledWith('user-1');
    expect(socket.join).toHaveBeenCalledWith('room_room-active');
    expect(socket.join).not.toHaveBeenCalledWith('room_room-pending');
  });

  it('does not register durable commands or client-controlled room subscriptions', () => {
    expect(handlers.join_room).toBeUndefined();
    expect(handlers.leave_room).toBeUndefined();
    expect(handlers.send_message).toBeUndefined();
    expect(handlers.update_message).toBeUndefined();
    expect(handlers.recall_message).toBeUndefined();
    expect(handlers.read_receipt).toBeUndefined();
    expect(handlers.typing).toBeDefined();
  });

  it('broadcasts typing only after validating current membership', async () => {
    await handlers.typing({ roomId: 'room-active', isTyping: true });

    expect(roomMemberRepo.findMember).toHaveBeenCalledWith('room-active', 'user-1');
    expect(roomEmit).toHaveBeenCalledWith('user_typing', {
      roomId: 'room-active',
      userId: 'user-1',
      isTyping: true,
    });
  });

  it('rejects typing from a non-member', async () => {
    roomMemberRepo.findMember.mockResolvedValue(null);

    await handlers.typing({ roomId: 'room-hidden', isTyping: true });

    expect(roomEmit).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', {
      statusCode: 403,
      message: 'Not a member of this room',
      code: 'FORBIDDEN',
    });
  });

  it('refreshes typing without re-checking membership', async () => {
    // Let the connection's own subscription restore settle first: it calls
    // findMember once per active room, and that call is not what this pins.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const membershipChecks = () => roomMemberRepo.findMember.mock.calls.length;
    const baseline = membershipChecks();

    await handlers.typing({ roomId: 'room-active', isTyping: true });
    await handlers.typing({ roomId: 'room-active', isTyping: true });
    await handlers.typing({ roomId: 'room-active', isTyping: true });

    expect(membershipChecks() - baseline).toBe(1);
  });

  /**
   * The client arms its own removal timer only when it receives `true`
   * (`frontend/src/context/ChatContext.tsx:1593-1607`), so every refresh has to
   * reach the room. Collapsing these into a single edge event makes the
   * indicator vanish after one client timeout while the user is still typing.
   */
  it('re-broadcasts every typing refresh, which is the client heartbeat', async () => {
    await handlers.typing({ roomId: 'room-active', isTyping: true });
    await handlers.typing({ roomId: 'room-active', isTyping: true });
    await handlers.typing({ roomId: 'room-active', isTyping: true });

    expect(roomEmit).toHaveBeenCalledTimes(3);
    expect(roomEmit).toHaveBeenLastCalledWith('user_typing', {
      roomId: 'room-active',
      userId: 'user-1',
      isTyping: true,
    });
  });

  it('re-checks membership once per TTL even while a claim is refreshed', async () => {
    const previous = process.env.TYPING_TTL_MS;
    process.env.TYPING_TTL_MS = '10';
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const membershipChecks = () => roomMemberRepo.findMember.mock.calls.length;
      const baseline = membershipChecks();

      await handlers.typing({ roomId: 'room-active', isTyping: true });
      await handlers.typing({ roomId: 'room-active', isTyping: true });
      expect(membershipChecks() - baseline).toBe(1);

      // Access is revoked while the user keeps typing. The claim is refreshed
      // continuously, so only the TTL bound forces the re-check that stops them.
      roomMemberRepo.findMember.mockResolvedValue(null);
      await new Promise((resolve) => setTimeout(resolve, 25));
      await handlers.typing({ roomId: 'room-active', isTyping: true });

      expect(membershipChecks() - baseline).toBe(2);
      expect(socket.emit).toHaveBeenCalledWith('error', {
        statusCode: 403,
        message: 'Not a member of this room',
        code: 'FORBIDDEN',
      });
    } finally {
      if (previous === undefined) delete process.env.TYPING_TTL_MS;
      else process.env.TYPING_TTL_MS = previous;
    }
  });

  /**
   * `socketsLeave` removes the socket from the room but does not stop it
   * addressing that room, so losing the subscription has to invalidate the
   * cached membership check immediately rather than one TTL later.
   */
  it('stops trusting the membership cache once the socket leaves the room', async () => {
    await handlers.typing({ roomId: 'room-active', isTyping: true });
    const baseline = roomMemberRepo.findMember.mock.calls.length;
    roomEmit.mockClear();

    // What room revocation does, through publisher.removeUserFromRoom.
    socket.rooms.delete('room_room-active');
    roomMemberRepo.findMember.mockResolvedValue(null);
    await handlers.typing({ roomId: 'room-active', isTyping: true });

    expect(roomMemberRepo.findMember.mock.calls.length - baseline).toBe(1);
    expect(roomEmit).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', {
      statusCode: 403,
      message: 'Not a member of this room',
      code: 'FORBIDDEN',
    });
  });

  it('rejects a typing stop from a non-member', async () => {
    roomMemberRepo.findMember.mockResolvedValue(null);

    await handlers.typing({ roomId: 'room-hidden', isTyping: false });

    expect(roomEmit).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', {
      statusCode: 403,
      message: 'Not a member of this room',
      code: 'FORBIDDEN',
    });
  });

  it('does not broadcast a stop for a room this socket never claimed', async () => {
    await handlers.typing({ roomId: 'room-active', isTyping: false });

    expect(roomEmit).not.toHaveBeenCalled();
  });

  it('expires typing automatically at the server TTL', async () => {
    const previous = process.env.TYPING_TTL_MS;
    process.env.TYPING_TTL_MS = '10';
    try {
      await handlers.typing({ roomId: 'room-active', isTyping: true });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(roomEmit).toHaveBeenLastCalledWith('user_typing', {
        roomId: 'room-active',
        userId: 'user-1',
        isTyping: false,
      });
    } finally {
      if (previous === undefined) delete process.env.TYPING_TTL_MS;
      else process.env.TYPING_TTL_MS = previous;
    }
  });

  describe('with friendRepository', () => {
    const friendRepo = { getFriends: mock() };

    beforeEach(() => {
      presence.trackUserConnection.mockClear();
      presence.trackUserDisconnection.mockClear();

      let frConnectionHandler: any;
      const frHandlers: Record<string, any> = {};
      const frSocket = {
        id: 'socket-fr-1',
        data: { user: { userId: 'user-1', name: 'Alice' } },
        rooms: new Set(['user_user-1', 'room_room-active']),
        join: mock(),
        leave: mock(),
        emit: mock(),
        to: mock(() => ({ emit: mock() })),
        on: mock((event, handler) => {
          frHandlers[event] = handler;
        }),
      };
      const frIo = {
        on: mock((event, handler) => {
          if (event === 'connection') frConnectionHandler = handler;
        }),
        to: mock(() => ({ emit: mock() })),
      } as unknown as ChatServer;

      attachSockets(frIo, {
        roomMemberRepository: roomMemberRepo,
        friendRepository: friendRepo,
        presence,
      });
      frConnectionHandler(frSocket);
      frHandlers.disconnect();
    });

    it('tracks a session on connect and disconnect', () => {
      expect(presence.trackUserConnection).toHaveBeenCalledWith(
        expect.anything(), 'user-1', 'socket-fr-1', friendRepo,
      );
      expect(presence.trackUserDisconnection).toHaveBeenCalledWith(
        expect.anything(), 'user-1', 'socket-fr-1', friendRepo,
      );
    });
  });
  describe('session limit', () => {
    const makeSocket = (id: string) => ({
      id,
      data: { user: { userId: 'user-1', name: 'Alice' } },
      join: mock(),
      leave: mock(),
      emit: mock(),
      to: mock(() => ({ emit: mock() })),
      on: mock(),
    });

    const attachLimited = (limit: string, reservationTtl?: string) => {
      const previous = process.env.MAX_SESSIONS_PER_USER;
      const previousTtl = process.env.SESSION_RESERVATION_TTL_MS;
      process.env.MAX_SESSIONS_PER_USER = limit;
      if (reservationTtl !== undefined) process.env.SESSION_RESERVATION_TTL_MS = reservationTtl;
      let middleware: any;
      let connect: any;
      const io = {
        use: mock((fn: any) => { middleware = fn; }),
        on: mock((event: string, handler: any) => {
          if (event === 'connection') connect = handler;
        }),
        to: mock(() => ({ emit: mock() })),
      } as unknown as ChatServer;
      attachSockets(io, { roomMemberRepository: roomMemberRepo });
      process.env.MAX_SESSIONS_PER_USER = previous;
      process.env.SESSION_RESERVATION_TTL_MS = previousTtl;
      return { middleware: middleware!, connect: connect! };
    };

    it('reserves a slot during the handshake so concurrent handshakes cannot overshoot', () => {
      const { middleware } = attachLimited('2');
      const results: Array<Error | undefined> = [];

      // Three handshakes complete their middleware before any of them reaches
      // the connection handler — the case that made the limit unenforceable.
      for (const id of ['s1', 's2', 's3']) {
        middleware(makeSocket(id), (err?: Error) => results.push(err));
      }

      expect(results[0]).toBeUndefined();
      expect(results[1]).toBeUndefined();
      expect(results[2]?.message).toBe('Session limit reached');
    });

    it('reclaims a reserved slot when the handshake never reaches connection', async () => {
      const { middleware } = attachLimited('1', '5');

      // The transport dies after the middleware runs, so the connection
      // handler — and with it the disconnect listener — never runs.
      middleware(makeSocket('aborted'), () => {});
      const whileReserved: Array<Error | undefined> = [];
      middleware(makeSocket('s2'), (err?: Error) => whileReserved.push(err));
      expect(whileReserved[0]?.message).toBe('Session limit reached');

      await new Promise((resolve) => setTimeout(resolve, 25));

      const afterExpiry: Array<Error | undefined> = [];
      middleware(makeSocket('s3'), (err?: Error) => afterExpiry.push(err));
      expect(afterExpiry[0]).toBeUndefined();
    });

    it('keeps the slot of a connection that arrived before its reservation expired', async () => {
      const { middleware, connect } = attachLimited('1', '5');
      const first = makeSocket('s1');
      const firstHandlers: Record<string, any> = {};
      first.on = mock((event: string, handler: any) => { firstHandlers[event] = handler; }) as any;

      middleware(first, () => {});
      connect(first);

      // The reservation timer must not hand this live session's slot back.
      await new Promise((resolve) => setTimeout(resolve, 25));

      const blocked: Array<Error | undefined> = [];
      middleware(makeSocket('s2'), (err?: Error) => blocked.push(err));
      expect(blocked[0]?.message).toBe('Session limit reached');

      firstHandlers.disconnect();
      const afterDisconnect: Array<Error | undefined> = [];
      middleware(makeSocket('s3'), (err?: Error) => afterDisconnect.push(err));
      expect(afterDisconnect[0]).toBeUndefined();
    });

    it('rejects a connection whose reservation expired once the limit refilled', async () => {
      const { middleware, connect } = attachLimited('1', '5');
      const late: any = { ...makeSocket('late'), disconnect: mock() };
      late.on = mock() as any;

      // The handshake reserves the only slot, then stalls past the TTL, so the
      // timer hands the slot back.
      middleware(late, () => {});
      await new Promise((resolve) => setTimeout(resolve, 25));

      // Someone else takes the freed slot and stays connected.
      const holder = makeSocket('holder');
      const holderHandlers: Record<string, any> = {};
      holder.on = mock((event: string, handler: any) => { holderHandlers[event] = handler; }) as any;
      const holderResult: Array<Error | undefined> = [];
      middleware(holder, (err?: Error) => holderResult.push(err));
      expect(holderResult[0]).toBeUndefined();
      connect(holder);

      // Now the stalled handshake finally reaches the connection handler. It no
      // longer holds a reservation, so taking a slot unconditionally would put
      // the user at two sessions against a limit of one.
      connect(late);

      expect(late.disconnect).toHaveBeenCalled();
      expect(late.join).not.toHaveBeenCalled();

      // The count must still be exactly the holder's one session.
      const after: Array<Error | undefined> = [];
      middleware(makeSocket('s3'), (err?: Error) => after.push(err));
      expect(after[0]?.message).toBe('Session limit reached');

      holderHandlers.disconnect();
      const afterRelease: Array<Error | undefined> = [];
      middleware(makeSocket('s4'), (err?: Error) => afterRelease.push(err));
      expect(afterRelease[0]).toBeUndefined();
    });

    it('frees the reserved slot when the session disconnects', () => {
      const { middleware, connect } = attachLimited('1');
      const first = makeSocket('s1');
      const firstHandlers: Record<string, any> = {};
      first.on = mock((event: string, handler: any) => { firstHandlers[event] = handler; }) as any;

      middleware(first, () => {});
      connect(first);
      const blocked: Array<Error | undefined> = [];
      middleware(makeSocket('s2'), (err?: Error) => blocked.push(err));
      expect(blocked[0]?.message).toBe('Session limit reached');

      firstHandlers.disconnect();
      const afterDisconnect: Array<Error | undefined> = [];
      middleware(makeSocket('s3'), (err?: Error) => afterDisconnect.push(err));
      expect(afterDisconnect[0]).toBeUndefined();
    });
  });

  /**
   * The cluster half of what #640 fixed inside one process.
   *
   * With a cluster adapter installed, `socket.to(room)` reaches every instance,
   * so `false` from this process's last claim retracts the indication for a
   * user who is still typing on another instance. These pin that the retraction
   * is now the store's decision, and that it stays this process's decision when
   * no store is wired.
   */
  describe('with a cross-instance typing store', () => {
    let storeHandlers: Record<string, any>;
    let storeSocket: any;
    let storeRoomEmit: Mock<any>;
    let claims: Array<[string, string]>;
    let releases: Array<[string, string]>;
    let holdersLeft: number;
    /** Resolves the next `release` by hand, to open a window mid-flight. */
    let blockRelease: (() => void) | undefined;

    const attachWithStore = (id = 'socket-1') => {
      const handlers: Record<string, any> = {};
      const emitToRoom = mock();
      const socket = {
        id,
        data: { user: { userId: 'user-1', name: 'Alice' } },
        rooms: new Set(['user_user-1', 'room_room-active']),
        join: mock(),
        leave: mock(),
        emit: mock(),
        to: mock(() => ({ emit: emitToRoom })),
        on: mock((event: string, handler: any) => { handlers[event] = handler; }),
      };
      return { handlers, socket, emitToRoom };
    };

    let connect: (socket: any) => void;

    beforeEach(() => {
      claims = [];
      releases = [];
      holdersLeft = 0;
      blockRelease = undefined;

      const typingStore = {
        async claim(roomId: string, userId: string) {
          claims.push([roomId, userId]);
          return { ok: true as const, value: undefined };
        },
        async release(roomId: string, userId: string) {
          releases.push([roomId, userId]);
          if (blockRelease) {
            await new Promise<void>((resolve) => { blockRelease = resolve; });
          }
          return { ok: true as const, value: holdersLeft };
        },
      };

      let handler: any;
      const io = {
        on: mock((event: string, fn: any) => { if (event === 'connection') handler = fn; }),
        to: mock(() => ({ emit: mock() })),
      } as unknown as ChatServer;

      attachSockets(io, {
        roomMemberRepository: {
          findByUser: mock().mockResolvedValue([{ roomId: 'room-active', role: 'member' }]),
          findMember: mock().mockResolvedValue({ roomId: 'room-active', role: 'member' }),
        } as any,
        typingStore,
      });
      connect = handler;

      const first = attachWithStore();
      storeHandlers = first.handlers;
      storeSocket = first.socket;
      storeRoomEmit = first.emitToRoom;
      connect(storeSocket);
    });

    it('claims in Redis on every refresh, without waiting for it to answer', async () => {
      await storeHandlers.typing({ roomId: 'room-active', isTyping: true });

      // The heartbeat states local truth, so it must not sit behind a round trip.
      expect(storeRoomEmit).toHaveBeenCalledWith('user_typing', {
        roomId: 'room-active',
        userId: 'user-1',
        isTyping: true,
      });
      await Promise.resolve();
      expect(claims).toEqual([['room-active', 'user-1']]);
    });

    it('retracts only once no instance holds a claim', async () => {
      await storeHandlers.typing({ roomId: 'room-active', isTyping: true });
      storeRoomEmit.mockClear();

      holdersLeft = 0;
      await storeHandlers.typing({ roomId: 'room-active', isTyping: false });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(releases).toEqual([['room-active', 'user-1']]);
      expect(storeRoomEmit).toHaveBeenCalledWith('user_typing', {
        roomId: 'room-active',
        userId: 'user-1',
        isTyping: false,
      });
    });

    it('stays silent while another instance still claims the same room member', async () => {
      await storeHandlers.typing({ roomId: 'room-active', isTyping: true });
      storeRoomEmit.mockClear();

      // The user is typing from a second instance; this one is not the last.
      holdersLeft = 1;
      await storeHandlers.typing({ roomId: 'room-active', isTyping: false });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(releases).toHaveLength(1);
      expect(storeRoomEmit).not.toHaveBeenCalled();
    });

    /**
     * The race the reconciler exists for. A keystroke landing while a release
     * is in flight has to both suppress the retraction and put the field back —
     * a plain claim/release pair would let the HDEL win and leave this instance
     * holding a live local claim that Redis knows nothing about.
     */
    it('suppresses a retraction overtaken by a keystroke, and re-claims', async () => {
      await storeHandlers.typing({ roomId: 'room-active', isTyping: true });
      storeRoomEmit.mockClear();
      claims.length = 0;

      blockRelease = () => {};
      holdersLeft = 0;
      const stopped = storeHandlers.typing({ roomId: 'room-active', isTyping: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(releases).toHaveLength(1);

      // Typing resumes before Redis has answered the release.
      await storeHandlers.typing({ roomId: 'room-active', isTyping: true });
      blockRelease?.();
      await stopped;
      await new Promise((resolve) => setTimeout(resolve, 0));

      const retracted = storeRoomEmit.mock.calls.some(
        ([, payload]: any[]) => payload?.isTyping === false,
      );
      expect(retracted).toBe(false);
      expect(claims).toEqual([['room-active', 'user-1']]);
    });

    it('retracts anyway when Redis cannot answer', async () => {
      const failing = {
        claim: async () => ({ ok: true as const, value: undefined }),
        release: async () => ({ ok: false as const, error: new Error('down') }),
      };
      let handler: any;
      const io = {
        on: mock((event: string, fn: any) => { if (event === 'connection') handler = fn; }),
        to: mock(() => ({ emit: mock() })),
      } as unknown as ChatServer;
      attachSockets(io, {
        roomMemberRepository: {
          findByUser: mock().mockResolvedValue([{ roomId: 'room-active', role: 'member' }]),
          findMember: mock().mockResolvedValue({ roomId: 'room-active', role: 'member' }),
        } as any,
        typingStore: failing,
      });
      const { handlers, socket, emitToRoom } = attachWithStore('socket-down');
      handler(socket);

      await handlers.typing({ roomId: 'room-active', isTyping: true });
      emitToRoom.mockClear();
      await handlers.typing({ roomId: 'room-active', isTyping: false });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Suppressing here would strand an indicator nobody can clear.
      expect(emitToRoom).toHaveBeenCalledWith('user_typing', {
        roomId: 'room-active',
        userId: 'user-1',
        isTyping: false,
      });
    });

    it('still retracts when the socket disconnects', async () => {
      await storeHandlers.typing({ roomId: 'room-active', isTyping: true });
      storeRoomEmit.mockClear();
      holdersLeft = 0;

      storeHandlers.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(storeRoomEmit).toHaveBeenCalledWith('user_typing', {
        roomId: 'room-active',
        userId: 'user-1',
        isTyping: false,
      });
    });

    it('asks the store nothing for a room this socket never claimed', async () => {
      await storeHandlers.typing({ roomId: 'room-active', isTyping: false });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(releases).toEqual([]);
      expect(storeRoomEmit).not.toHaveBeenCalled();
    });
  });
});
