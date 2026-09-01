import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

const mockSqlFn: any = mock().mockResolvedValue([{}]);
mockSqlFn.unsafe = mock().mockResolvedValue([{}]);
mock.module('../../../src/models/db', () => ({
  default: mockSqlFn,
}));

import { createServer, type Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { signToken } from '../../../src/utils/jwt';
import { attachSocketAuth, type ChatServer } from '../../../src/realtime/authSocket';
import { attachSockets } from '../../../src/realtime/socketServer';
import type { ClientToServerEvents, ServerToClientEvents } from '../../../../shared/types';

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const waitFor = <T>(socket: TestClient, event: keyof ServerToClientEvents): Promise<T> =>
  new Promise((resolve) => {
    socket.once(event, (payload: any) => resolve(payload as T));
  });

async function waitForExpect(fn: () => void, timeout = 1000, interval = 25) {
  const start = Date.now();
  while (true) {
    try {
      fn();
      return;
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

describe('Socket.IO ephemeral events E2E', () => {
  let httpServer: HttpServer;
  let ioServer: ChatServer;
  let url: string;
  let clients: TestClient[];
  let roomMemberRepository: {
    findByUser: ReturnType<typeof mock>;
    findMember: ReturnType<typeof mock>;
  };

  const connectClient = async (userId: string, tokenInput?: string | Promise<string>): Promise<TestClient> => {
    const token = await (tokenInput !== undefined ? tokenInput : signToken({ userId, name: userId }));
    return new Promise((resolve, reject) => {
      const socket: TestClient = createClient(url, {
        auth: token ? { token } : {},
        forceNew: true,
        transports: ['websocket'],
      });
      clients.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  };

  beforeEach(async () => {
    process.env.MAX_SESSIONS_PER_USER = '5';
    httpServer = createServer();
    ioServer = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
      cors: { origin: '*' },
    }) as ChatServer;
    roomMemberRepository = {
      findByUser: mock().mockResolvedValue([
        { roomId: 'room-1', role: 'member' },
        { roomId: 'room-pending', role: 'pending' },
      ]),
      findMember: mock().mockResolvedValue({ roomId: 'room-1', role: 'member' }),
    };
    clients = [];

    attachSocketAuth(ioServer);
    attachSockets(ioServer, { roomMemberRepository });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    delete process.env.MAX_SESSIONS_PER_USER;
    clients.forEach((socket) => {
      try { socket.disconnect(); } catch {}
    });
    try { ioServer.disconnectSockets(true); } catch {}
    await Promise.race([
      new Promise<void>((resolve) => ioServer.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 300)),
    ]);
    await Promise.race([
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 300)),
    ]);
  });

  it('rejects connections without a token', async () => {
    await expect(connectClient('anonymous', '')).rejects.toThrow('Authentication error');
  });

  it('derives room subscriptions from active membership and excludes pending membership', async () => {
    const client = await connectClient('user-1');

    await waitForExpect(() => {
      expect(ioServer.sockets.adapter.rooms.get('room_room-1')?.has(client.id!)).toBe(true);
    });
    expect(ioServer.sockets.adapter.rooms.get('room_room-pending')?.has(client.id!)).not.toBe(true);
    expect(roomMemberRepository.findByUser).toHaveBeenCalledWith('user-1');
  });

  it('broadcasts typing only to the derived room after validating membership', async () => {
    const sender = await connectClient('user-1');
    const receiver = await connectClient('user-2');

    await waitForExpect(() => {
      expect(ioServer.sockets.adapter.rooms.get('room_room-1')?.has(receiver.id!)).toBe(true);
    });

    const received = waitFor<Parameters<ServerToClientEvents['user_typing']>[0]>(receiver, 'user_typing');
    sender.emit('typing', { roomId: 'room-1', isTyping: true });

    await expect(received).resolves.toEqual({
      roomId: 'room-1',
      userId: 'user-1',
      isTyping: true,
    });
    expect(roomMemberRepository.findMember).toHaveBeenCalledWith('room-1', 'user-1');
  });

  it('rejects typing from a non-member', async () => {
    const client = await connectClient('user-1');
    roomMemberRepository.findMember.mockResolvedValue(null);

    const errorPayload = waitFor<Parameters<ServerToClientEvents['error']>[0]>(client, 'error');
    client.emit('typing', { roomId: 'room-hidden', isTyping: true });

    await expect(errorPayload).resolves.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'Not a member of this room',
    });
  });

  it('expires typing automatically at the server TTL', async () => {
    const previous = process.env.TYPING_TTL_MS;
    process.env.TYPING_TTL_MS = '10';
    try {
      const sender = await connectClient('user-1');
      const receiver = await connectClient('user-2');
      await waitForExpect(() => {
        expect(ioServer.sockets.adapter.rooms.get('room_room-1')?.has(receiver.id!)).toBe(true);
      });

      const received = waitFor<Parameters<ServerToClientEvents['user_typing']>[0]>(receiver, 'user_typing');
      sender.emit('typing', { roomId: 'room-1', isTyping: true });
      await expect(received).resolves.toMatchObject({ isTyping: true });

      const expired = waitFor<Parameters<ServerToClientEvents['user_typing']>[0]>(receiver, 'user_typing');
      await expect(expired).resolves.toMatchObject({
        roomId: 'room-1',
        userId: 'user-1',
        isTyping: false,
      });
    } finally {
      if (previous === undefined) delete process.env.TYPING_TTL_MS;
      else process.env.TYPING_TTL_MS = previous;
    }
  });

  /**
   * Two sockets for one user is the ordinary case — one browser tab each — and
   * `user_typing` speaks about the user, not the socket. These two pin that one
   * tab can neither cancel nor duplicate the other's claim.
   */
  const openTypingPair = async () => {
    const tabA = await connectClient('user-1');
    const tabB = await connectClient('user-1');
    const observer = await connectClient('user-2');

    await waitForExpect(() => {
      const members = ioServer.sockets.adapter.rooms.get('room_room-1');
      expect(members?.has(observer.id!)).toBe(true);
      expect(members?.has(tabA.id!)).toBe(true);
      expect(members?.has(tabB.id!)).toBe(true);
    });

    const seen: Parameters<ServerToClientEvents['user_typing']>[0][] = [];
    observer.on('user_typing', (payload) => seen.push(payload));
    return { tabA, tabB, seen };
  };

  it('keeps a user typing when another of their sessions stops', async () => {
    const { tabA, tabB, seen } = await openTypingPair();

    tabA.emit('typing', { roomId: 'room-1', isTyping: true });
    await waitForExpect(() => {
      expect(seen).toEqual([{ roomId: 'room-1', userId: 'user-1', isTyping: true }]);
    });

    // The idle tab retracting a claim it never made must not stop the user.
    tabB.emit('typing', { roomId: 'room-1', isTyping: false });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seen).toEqual([{ roomId: 'room-1', userId: 'user-1', isTyping: true }]);

    tabA.emit('typing', { roomId: 'room-1', isTyping: false });
    await waitForExpect(() => {
      expect(seen).toEqual([
        { roomId: 'room-1', userId: 'user-1', isTyping: true },
        { roomId: 'room-1', userId: 'user-1', isTyping: false },
      ]);
    });
  });

  it('keeps a user typing when one of two typing sessions disconnects', async () => {
    const { tabA, tabB, seen } = await openTypingPair();

    tabA.emit('typing', { roomId: 'room-1', isTyping: true });
    await waitForExpect(() => expect(seen).toHaveLength(1));

    // The second claim is not news, so it is not broadcast either.
    tabB.emit('typing', { roomId: 'room-1', isTyping: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seen).toHaveLength(1);

    tabB.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seen).toHaveLength(1);

    tabA.emit('typing', { roomId: 'room-1', isTyping: false });
    await waitForExpect(() => {
      expect(seen.at(-1)).toEqual({ roomId: 'room-1', userId: 'user-1', isTyping: false });
    });
  });

  it('enforces the per-user session limit', async () => {
    process.env.MAX_SESSIONS_PER_USER = '1';
    // This server was created with the default limit; rebuild it with the test limit.
    clients.forEach((socket) => socket.disconnect());
    ioServer.disconnectSockets(true);
    await new Promise<void>((resolve) => ioServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));

    httpServer = createServer();
    ioServer = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer) as ChatServer;
    attachSocketAuth(ioServer);
    attachSockets(ioServer, { roomMemberRepository });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const address = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;

    const first = await connectClient('user-1');
    await expect(connectClient('user-1')).rejects.toThrow('Session limit reached');
    first.disconnect();
  });
});
