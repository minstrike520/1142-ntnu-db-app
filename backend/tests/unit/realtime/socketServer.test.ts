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
});
