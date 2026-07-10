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

import { createServer, type Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';

import { signToken } from '../../../src/auth/jwt';
import { ForbiddenError } from '../../../src/errors/AppError';
import { attachSocketAuth, type ChatServer } from '../../../src/realtime/authSocket';
import { attachSockets } from '../../../src/realtime/socketServer';
import type { ClientToServerEvents, MessageWithSender, ServerToClientEvents } from '../../../../shared/types';

vi.mock('../../../src/db', () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [{}] }) },
}));

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const message: MessageWithSender = {
  messageId: 'msg-1',
  roomId: 'room-1',
  senderId: 'user-1',
  content: 'hello',
  isRecalled: false,
  sentAt: new Date('2026-01-01T00:00:00.000Z'),
  sender: { userId: 'user-1', name: 'Alice' },
};

const waitFor = <T>(socket: TestClient, event: keyof ServerToClientEvents): Promise<T> =>
  new Promise((resolve) => {
    socket.once(event, (payload) => resolve(payload as T));
  });

describe('Socket.IO chat events E2E', () => {
  let httpServer: HttpServer;
  let ioServer: ChatServer;
  let url: string;
  let clients: TestClient[];
  let messageService: {
    sendMessage: ReturnType<typeof vi.fn>;
    recallMessage: ReturnType<typeof vi.fn>;
  };
  let messageRepository: {
    findById: ReturnType<typeof vi.fn>;
  };
  let roomMemberRepository: {
    update: ReturnType<typeof vi.fn>;
  };

  const connectClient = (userId: string, token = signToken({ userId, name: userId })): Promise<TestClient> =>
    new Promise((resolve, reject) => {
      const socket: TestClient = createClient(url, {
        auth: token ? { token } : {},
        forceNew: true,
        transports: ['websocket'],
      });
      clients.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });

  beforeEach(async () => {
    httpServer = createServer();
    ioServer = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
      cors: { origin: '*' },
    }) as ChatServer;
    messageService = {
      sendMessage: vi.fn(),
      recallMessage: vi.fn(),
    };
    messageRepository = {
      findById: vi.fn().mockResolvedValue(message),
    };
    roomMemberRepository = {
      update: vi.fn(),
      findMember: vi.fn().mockResolvedValue({ role: 'member' }),
    };
    clients = [];

    attachSocketAuth(ioServer);
    attachSockets(ioServer, { messageService, messageRepository, roomMemberRepository });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    clients.forEach((socket) => {
      try { socket.disconnect(); } catch (e) {}
    });
    try { ioServer.disconnectSockets(true); } catch (e) {}
    await Promise.race([
      new Promise<void>((resolve) => ioServer.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 300))
    ]);
    await Promise.race([
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 300))
    ]);
  });

  it('rejects connections without a token', async () => {
    await expect(connectClient('anonymous', '')).rejects.toThrow('Authentication error');
  });

  it('lets users join and leave rooms', async () => {
    const client = await connectClient('user-1');

    client.emit('join_room', { roomId: 'room-1' });
    await vi.waitFor(() => {
      expect(ioServer.sockets.adapter.rooms.get('room_room-1')?.has(client.id!)).toBe(true);
    });

    client.emit('leave_room', { roomId: 'room-1' });
    await vi.waitFor(() => {
      expect(ioServer.sockets.adapter.rooms.get('room_room-1')?.has(client.id!)).not.toBe(true);
    });
  });

  it('emits new_message to room members when send_message succeeds', async () => {
    const sender = await connectClient('user-1');
    const receiver = await connectClient('user-2');
    messageService.sendMessage.mockResolvedValue(message);

    receiver.emit('join_room', { roomId: 'room-1' });
    await vi.waitFor(() => {
      expect(ioServer.sockets.adapter.rooms.get('room_room-1')?.has(receiver.id!)).toBe(true);
    });

    const received = waitFor<MessageWithSender>(receiver, 'new_message');
    sender.emit('send_message', { roomId: 'room-1', content: 'hello' });

    await expect(received).resolves.toMatchObject({
      messageId: 'msg-1',
      content: 'hello',
      sender: { userId: 'user-1', name: 'Alice' },
    });
    expect(messageService.sendMessage).toHaveBeenCalledWith('user-1', 'room-1', 'hello', {
      replyToId: undefined,
      attachmentIds: undefined,
    });
  });

  it('broadcasts new_message payloads with resolved mentions', async () => {
    const sender = await connectClient('user-1');
    const receiver = await connectClient('user-2');
    messageService.sendMessage.mockResolvedValue({
      ...message,
      content: 'hello @Bob',
      mentions: ['user-2'],
    });

    receiver.emit('join_room', { roomId: 'room-1' });
    await vi.waitFor(() => {
      expect(ioServer.sockets.adapter.rooms.get('room_room-1')?.has(receiver.id!)).toBe(true);
    });

    const received = waitFor<MessageWithSender>(receiver, 'new_message');
    sender.emit('send_message', { roomId: 'room-1', content: 'hello @Bob' });

    await expect(received).resolves.toMatchObject({
      content: 'hello @Bob',
      mentions: ['user-2'],
    });
  });

  it('broadcasts @everyone mention payloads returned by the message service', async () => {
    const sender = await connectClient('user-1');
    const receiver = await connectClient('user-2');
    messageService.sendMessage.mockResolvedValue({
      ...message,
      content: 'hello @everyone',
      mentions: ['user-2', 'user-3'],
    });

    receiver.emit('join_room', { roomId: 'room-1' });
    await vi.waitFor(() => {
      expect(ioServer.sockets.adapter.rooms.get('room_room-1')?.has(receiver.id!)).toBe(true);
    });

    const received = waitFor<MessageWithSender>(receiver, 'new_message');
    sender.emit('send_message', { roomId: 'room-1', content: 'hello @everyone' });

    await expect(received).resolves.toMatchObject({
      content: 'hello @everyone',
      mentions: ['user-2', 'user-3'],
    });
    expect(messageService.sendMessage).toHaveBeenCalledWith('user-1', 'room-1', 'hello @everyone', {
      replyToId: undefined,
      attachmentIds: undefined,
    });
  });

  it('emits typed error when send_message is denied', async () => {
    const sender = await connectClient('user-1');
    messageService.sendMessage.mockRejectedValue(new ForbiddenError('Muted members cannot send messages'));

    const errorPayload = waitFor<Parameters<ServerToClientEvents['error']>[0]>(sender, 'error');
    sender.emit('send_message', { roomId: 'room-1', content: 'hello' });

    await expect(errorPayload).resolves.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'Muted members cannot send messages',
    });
  });


  it('broadcasts typing indicators', async () => {
    const sender = await connectClient('user-1');
    const receiver = await connectClient('user-2');

    receiver.emit('join_room', { roomId: 'room-1' });
    await vi.waitFor(() => {
      expect(ioServer.sockets.adapter.rooms.get('room_room-1')?.has(receiver.id!)).toBe(true);
    });

    const received = waitFor<Parameters<ServerToClientEvents['user_typing']>[0]>(receiver, 'user_typing');
    sender.emit('typing', { roomId: 'room-1', isTyping: true });

    await expect(received).resolves.toEqual({
      roomId: 'room-1',
      userId: 'user-1',
      isTyping: true,
    });
  });

  it('recalls messages and emits message_recalled', async () => {
    const sender = await connectClient('user-1');
    const receiver = await connectClient('user-2');
    messageRepository.findById.mockResolvedValue(message);
    messageService.recallMessage.mockResolvedValue({ ...message, isRecalled: true });

    receiver.emit('join_room', { roomId: 'room-1' });
    await vi.waitFor(() => {
      expect(ioServer.sockets.adapter.rooms.get('room_room-1')?.has(receiver.id!)).toBe(true);
    });

    const received = waitFor<Parameters<ServerToClientEvents['message_recalled']>[0]>(
      receiver,
      'message_recalled',
    );
    sender.emit('recall_message', { messageId: 'msg-1' });

    await expect(received).resolves.toEqual({ messageId: 'msg-1' });
    expect(messageService.recallMessage).toHaveBeenCalledWith('user-1', 'room-1', 'msg-1');
  });

  it('emits error when a non-sender recalls a message', async () => {
    const client = await connectClient('user-2');
    messageRepository.findById.mockResolvedValue(message);
    messageService.recallMessage.mockRejectedValue(new ForbiddenError('Only the original sender or an admin can recall this message'));

    const errorPayload = waitFor<Parameters<ServerToClientEvents['error']>[0]>(client, 'error');
    client.emit('recall_message', { messageId: 'msg-1' });

    await expect(errorPayload).resolves.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    expect(messageService.recallMessage).toHaveBeenCalledWith('user-2', 'room-1', 'msg-1');
  });

  it('broadcasts read receipts and updates database', async () => {
    const sender = await connectClient('user-1');
    const receiver = await connectClient('user-2');

    receiver.emit('join_room', { roomId: 'room-1' });
    await vi.waitFor(() => {
      expect(ioServer.sockets.adapter.rooms.get('room_room-1')?.has(receiver.id!)).toBe(true);
    });

    const received = waitFor<Parameters<ServerToClientEvents['read_update']>[0]>(receiver, 'read_update');
    sender.emit('read_receipt', { roomId: 'room-1', messageId: 'msg-1' });

    await expect(received).resolves.toEqual({
      roomId: 'room-1',
      userId: 'user-1',
      messageId: 'msg-1',
    });
    expect(roomMemberRepository.update).toHaveBeenCalledWith('room-1', 'user-1', { lastReadId: 'msg-1' });
  });
});
