import { describe, it, test, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';

// Bun-compatibility helper for Vitest/Jest APIs
import { mock, spyOn, afterAll, expect as originalExpect, jest } from 'bun:test';
let mockedModules: any[] = [];
afterAll(() => {
  for (const m of mockedModules) {
    if (m && m.path) {
      mock.module(m.path, () => m.original);
    }
  }
  mockedModules = [];
});
function createVitestMockProxy(f: any) {
  const extensions = {
    mockResolvedValue(val: any) {
      f.mockImplementation(() => Promise.resolve(val));
      return proxy;
    },
    mockRejectedValue(val: any) {
      f.mockImplementation(() => Promise.reject(val));
      return proxy;
    },
    mockResolvedValueOnce(val: any) {
      if (typeof f.mockImplementationOnce === "function") {
        f.mockImplementationOnce(() => Promise.resolve(val));
      } else {
        f.mockImplementation(() => Promise.resolve(val));
      }
      return proxy;
    },
    mockRejectedValueOnce(val: any) {
      if (typeof f.mockImplementationOnce === "function") {
        f.mockImplementationOnce(() => Promise.reject(val));
      } else {
        f.mockImplementation(() => Promise.reject(val));
      }
      return proxy;
    },
    mockReset() {
      f.mockClear();
      f.mockImplementation(() => {});
      return proxy;
    }
  };
  const proxy = new Proxy(f, {
    get(target, prop, receiver) {
      if (prop === "__is_vitest_mock_proxy__") return true;
      if (prop === "__original_target__") return target;
      if (prop in extensions) return (extensions as any)[prop];
      const val = Reflect.get(target, prop);
      if (typeof val === "function") return val.bind(target);
      return val;
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value);
    }
  });
  return proxy;
}
const vi = {
  fn: (impl?: any) => createVitestMockProxy(mock(impl)),
  spyOn: (obj: any, method: string) => createVitestMockProxy(spyOn(obj, method as any)),
  mock: (path: string, factory?: any) => {
    let original: any = null;
    try {
      original = require(path);
    } catch (e) {}
    mockedModules.push({ path, original });
    return mock.module(path, factory || (() => ({})));
  },
  mocked: <T>(obj: T) => obj as any,
  restoreAllMocks: () => {
    jest.restoreAllMocks();
    for (const m of mockedModules) {
      if (m && m.path) {
        mock.module(m.path, () => m.original);
      }
    }
    mockedModules = [];
  },
  resetAllMocks: () => {
    jest.resetAllMocks();
  },
  clearAllMocks: () => {
    jest.clearAllMocks();
  },
  stubEnv: (name: string, value: string) => {
    if (!globalThis.__envStubs) globalThis.__envStubs = {};
    if (!(name in globalThis.__envStubs)) globalThis.__envStubs[name] = process.env[name];
    process.env[name] = value;
  },
  unstubAllEnvs: () => {
    if (globalThis.__envStubs) {
      for (const name in globalThis.__envStubs) {
        const val = globalThis.__envStubs[name];
        if (val === undefined) delete process.env[name];
        else process.env[name] = val;
      }
      globalThis.__envStubs = null;
    }
  },
  useFakeTimers: () => {
    globalThis.__activeIntervals = [];
    globalThis.__originalSetInterval = globalThis.setInterval;
    globalThis.__originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = (callback: any, delay?: number, ...args: any[]) => {
      const id = Math.random();
      globalThis.__activeIntervals.push({ callback: () => callback(...args), delay: delay || 0, id });
      return id as any;
    };
    globalThis.clearInterval = (id: any) => {
      globalThis.__activeIntervals = globalThis.__activeIntervals.filter((item: any) => item.id !== id);
    };
  },
  useRealTimers: () => {
    if (globalThis.__originalSetInterval) {
      globalThis.setInterval = globalThis.__originalSetInterval;
      globalThis.clearInterval = globalThis.__originalClearInterval;
    }
    globalThis.__activeIntervals = [];
  },
  advanceTimersByTime: (ms: number) => {
    if (globalThis.__activeIntervals) {
      for (const item of globalThis.__activeIntervals) {
        item.callback();
      }
    }
  },
  advanceTimersByTimeAsync: async (ms: number) => {
    if (globalThis.__activeIntervals) {
      const promises = globalThis.__activeIntervals.map((item: any) => item.callback());
      await Promise.all(promises);
    }
  },
  waitFor: async (callback: () => any, options?: { timeout?: number; interval?: number }) => {
    const timeout = options?.timeout || 5000;
    const interval = options?.interval || 50;
    const startTime = Date.now();
    while (true) {
      try {
        await callback();
        return;
      } catch (err) {
        if (Date.now() - startTime > timeout) {
          throw err;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
  }
};
const expect = (actual: any) => {
  if (actual && typeof actual === 'function' && actual.__is_vitest_mock_proxy__) {
    actual = actual.__original_target__;
  }
  return originalExpect(actual);
};
Object.setPrototypeOf(expect, originalExpect);
Object.defineProperties(expect, Object.getOwnPropertyDescriptors(originalExpect));


import { ForbiddenError, NotFoundError } from '../../../src/errors/AppError';
import { attachSockets } from '../../../src/realtime/socketServer';
import type { ChatServer } from '../../../src/realtime/authSocket';
import type { MessageWithSender } from '../../../../shared/types';
import { trackUserConnection, trackUserDisconnection } from '../../../src/realtime/presence';

vi.mock('../../../src/realtime/presence', () => ({
  trackUserConnection: vi.fn().mockResolvedValue(undefined),
  trackUserDisconnection: vi.fn().mockResolvedValue(undefined),
}));

const message: MessageWithSender = {
  messageId: 'msg-1',
  roomId: 'room-1',
  senderId: 'user-1',
  content: 'hello',
  isRecalled: false,
  sentAt: new Date('2026-01-01T00:00:00.000Z'),
  sender: { userId: 'user-1', name: 'Alice' },
};

describe('attachSockets', () => {
  let connectionHandler: any;
  let handlers: Record<string, any>;
  let socket: any;
  let roomEmit: ReturnType<typeof vi.fn>;
  let service: {
    sendMessage: ReturnType<typeof vi.fn>;
    recallMessage: ReturnType<typeof vi.fn>;
  };
  let repo: { findById: ReturnType<typeof vi.fn> };
  let roomMemberRepo: { update: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    handlers = {};
    roomEmit = vi.fn();
    socket = {
      data: { user: { userId: 'user-1', name: 'Alice' } },
      join: vi.fn(),
      leave: vi.fn(),
      emit: vi.fn(),
      to: vi.fn(() => ({ emit: roomEmit })),
      on: vi.fn((event, handler) => {
        handlers[event] = handler;
      }),
    };
    service = {
      sendMessage: vi.fn(),
      recallMessage: vi.fn(),
    };
    repo = { findById: vi.fn() };
    roomMemberRepo = { update: vi.fn(), findMember: vi.fn() };

    const io = {
      on: vi.fn((event, handler) => {
        if (event === 'connection') connectionHandler = handler;
      }),
      to: vi.fn(() => ({ emit: roomEmit })),
    } as unknown as ChatServer;

    attachSockets(io, { messageService: service, messageRepository: repo, roomMemberRepository: roomMemberRepo });
    connectionHandler(socket);
  });

  it('handles join_room for members and leave_room', async () => {
    roomMemberRepo.findMember.mockResolvedValue({ role: 'member' } as any);
    await handlers.join_room({ roomId: 'room-1' });
    handlers.leave_room({ roomId: 'room-1' });

    expect(roomMemberRepo.findMember).toHaveBeenCalledWith('room-1', 'user-1');
    expect(socket.join).toHaveBeenCalledWith('room_room-1');
    expect(socket.leave).toHaveBeenCalledWith('room_room-1');
  });

  it('rejects join_room for non-members', async () => {
    roomMemberRepo.findMember.mockResolvedValue(null);
    await handlers.join_room({ roomId: 'room-2' });

    expect(socket.join).not.toHaveBeenCalledWith('room_room-2');
    expect(socket.emit).toHaveBeenCalledWith('error', {
      statusCode: 403,
      message: 'Not a member of this room',
      code: 'FORBIDDEN',
    });
  });

  it('sends messages through messageService and emits new_message to the room', async () => {
    service.sendMessage.mockResolvedValue(message);

    await handlers.send_message({
      roomId: 'room-1',
      content: 'hello',
      replyTo: 'msg-0',
      attachmentIds: ['550e8400-e29b-41d4-a716-446655440000'],
    });

    expect(service.sendMessage).toHaveBeenCalledWith('user-1', 'room-1', 'hello', {
      replyToId: 'msg-0',
      attachmentIds: ['550e8400-e29b-41d4-a716-446655440000'],
    });
    expect(roomEmit).toHaveBeenCalledWith('new_message', message);
  });

  it('emits ApiError payloads when send_message fails', async () => {
    service.sendMessage.mockRejectedValue(new NotFoundError('room', 'missing'));

    await handlers.send_message({ roomId: 'missing', content: 'hello' });

    expect(socket.emit).toHaveBeenCalledWith('error', {
      statusCode: 404,
      message: 'room with id missing not found',
      code: 'NOT_FOUND',
    });
  });

  it('recalls messages only for the original sender', async () => {
    repo.findById.mockResolvedValue(message);
    service.recallMessage.mockResolvedValue({ ...message, isRecalled: true });

    await handlers.recall_message({ messageId: 'msg-1' });

    expect(service.recallMessage).toHaveBeenCalledWith('user-1', 'room-1', 'msg-1');
    expect(roomEmit).toHaveBeenCalledWith('message_recalled', { messageId: 'msg-1' });
  });

  it('emits ForbiddenError when recallMessage fails with ForbiddenError', async () => {
    repo.findById.mockResolvedValue({ ...message, senderId: 'user-2' });
    service.recallMessage.mockRejectedValue(new ForbiddenError('Only the original sender or an admin can recall this message'));

    await handlers.recall_message({ messageId: 'msg-1' });

    expect(service.recallMessage).toHaveBeenCalledWith('user-1', 'room-1', 'msg-1');
    expect(socket.emit).toHaveBeenCalledWith('error', {
      statusCode: 403,
      message: 'Only the original sender or an admin can recall this message',
      code: 'FORBIDDEN',
    });
  });

  it('broadcasts typing and read receipts', async () => {
    const socketRoomEmit = vi.fn();
    socket.to.mockReturnValue({ emit: socketRoomEmit });
    repo.findById.mockResolvedValue(message); // msg-1 in room-1

    handlers.typing({ roomId: 'room-1', isTyping: true });
    await handlers.read_receipt({ roomId: 'room-1', messageId: 'msg-1' });

    expect(socketRoomEmit).toHaveBeenCalledWith('user_typing', {
      roomId: 'room-1',
      userId: 'user-1',
      isTyping: true,
    });
    expect(roomMemberRepo.update).toHaveBeenCalledWith('room-1', 'user-1', { lastReadId: 'msg-1' });
    expect(socketRoomEmit).toHaveBeenCalledWith('read_update', {
      roomId: 'room-1',
      userId: 'user-1',
      messageId: 'msg-1',
    });
  });

  it('rejects read_receipt for cross-room message', async () => {
    repo.findById.mockResolvedValue({ ...message, roomId: 'room-2' });

    await handlers.read_receipt({ roomId: 'room-1', messageId: 'msg-1' });

    expect(roomMemberRepo.update).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', {
      statusCode: 400,
      message: 'Invalid messageId for this room',
      code: 'VALIDATION_ERROR',
    });
  });

  it('emits NotFoundError when recall_message target does not exist', async () => {
    repo.findById.mockResolvedValue(null);

    await handlers.recall_message({ messageId: 'missing-msg' });

    expect(service.recallMessage).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', {
      statusCode: 404,
      message: 'message with id missing-msg not found',
      code: 'NOT_FOUND',
    });
  });

  describe('with friendRepository', () => {
    let frHandlers: Record<string, any>;
    let frSocket: any;
    const friendRepo = { getFriends: vi.fn() };

    beforeEach(() => {
      vi.mocked(trackUserConnection).mockClear();
      vi.mocked(trackUserDisconnection).mockClear();

      frHandlers = {};
      frSocket = {
        id: 'socket-fr-1',
        data: { user: { userId: 'user-1', name: 'Alice' } },
        join: vi.fn(),
        leave: vi.fn(),
        emit: vi.fn(),
        to: vi.fn(() => ({ emit: vi.fn() })),
        on: vi.fn((event, handler) => { frHandlers[event] = handler; }),
      };

      let frConnectionHandler: any;
      const frIo = {
        on: vi.fn((event, handler) => { if (event === 'connection') frConnectionHandler = handler; }),
        to: vi.fn(() => ({ emit: vi.fn() })),
      } as unknown as ChatServer;

      attachSockets(frIo, {
        messageService: service,
        messageRepository: repo,
        roomMemberRepository: roomMemberRepo,
        friendRepository: friendRepo,
      });
      frConnectionHandler(frSocket);
    });

    it('calls trackUserConnection on connect when friendRepository is provided', () => {
      expect(trackUserConnection).toHaveBeenCalledWith(
        expect.anything(), 'user-1', 'socket-fr-1', friendRepo,
      );
    });

    it('calls trackUserDisconnection on disconnect when friendRepository is provided', () => {
      frHandlers.disconnect();
      expect(trackUserDisconnection).toHaveBeenCalledWith(
        expect.anything(), 'user-1', 'socket-fr-1', friendRepo,
      );
    });
  });
});
