import { describe, it, expect, beforeEach, afterAll, mock, type Mock } from 'bun:test';
import { attachSockets } from '../../../src/realtime/socketServer';
import type { ChatServer } from '../../../src/realtime/authSocket';
import { trackUserConnection, trackUserDisconnection } from '../../../src/realtime/presence';

mock.module('../../../src/realtime/presence', () => ({
  trackUserConnection: mock().mockResolvedValue(undefined),
  trackUserDisconnection: mock().mockResolvedValue(undefined),
}));

afterAll(() => {
  mock.module('../../../src/realtime/presence', () => require('../../../src/realtime/presence?original'));
});

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
      ((trackUserConnection as any) as Mock<any>).mockClear();
      ((trackUserDisconnection as any) as Mock<any>).mockClear();

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

      attachSockets(frIo, { roomMemberRepository: roomMemberRepo, friendRepository: friendRepo });
      frConnectionHandler(frSocket);
      frHandlers.disconnect();
    });

    it('tracks a session on connect and disconnect', () => {
      expect(trackUserConnection).toHaveBeenCalledWith(
        expect.anything(), 'user-1', 'socket-fr-1', friendRepo,
      );
      expect(trackUserDisconnection).toHaveBeenCalledWith(
        expect.anything(), 'user-1', 'socket-fr-1', friendRepo,
      );
    });
  });
});
