import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from 'bun:test';

// Mock the db module before other imports to prevent real DB connection in this specific test
mock.module('../../../src/models/db', () => ({
  default: { query: mock().mockResolvedValue({ rows: [{}] }) },
}));

import { createServer, type Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { signToken } from '../../../src/utils/jwt';
import { ForbiddenError } from '../../../src/utils/AppError';
import { attachSocketAuth, type ChatServer } from '../../../src/realtime/authSocket';
import { attachSockets } from '../../../src/realtime/socketServer';
import type { ClientToServerEvents, MessageWithSender, ServerToClientEvents } from '../../../../shared/types';

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
    socket.once(event, (payload: any) => resolve(payload as T));
  });

async function waitForExpect(fn: () => void, timeout = 1000, interval = 50) {
  const start = Date.now();
  while (true) {
    try {
      fn();
      return;
    } catch (e) {
      if (Date.now() - start > timeout) throw e;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

describe('Socket.IO chat events E2E', () => {
  let httpServer: HttpServer;
  let ioServer: ChatServer;
  let url: string;
  let clients: TestClient[];
  let messageService: {
    sendMessage: any;
    recallMessage: any;
  };
  let messageRepository: {
    findById: any;
  };
  let roomMemberRepository: {
    update: any;
    findMember: any;
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
    httpServer = createServer();
    ioServer = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
      cors: { origin: '*' },
    }) as ChatServer;
    messageService = {
      sendMessage: mock(),
      recallMessage: mock(),
    };
    messageRepository = {
      findById: mock().mockResolvedValue(message),
    };
    roomMemberRepository = {
      update: mock(),
      findMember: mock().mockResolvedValue({ role: 'member' }),
    };
    clients = [];

    attachSocketAuth(ioServer);
    attachSockets(ioServer, { messageService: messageService as any, messageRepository: messageRepository as any, roomMemberRepository: roomMemberRepository as any });

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
    await waitForExpect(() => {
      expect(ioServer.sockets.adapter.rooms.get('room_room-1')?.has(client.id!)).toBe(true);
    });

    client.emit('leave_room', { roomId: 'room-1' });
    await waitForExpect(() => {
      expect(ioServer.sockets.adapter.rooms.get('room_room-1')?.has(client.id!)).not.toBe(true);
    });
  });

  it('emits new_message to room members when send_message succeeds', async () => {
    const sender = await connectClient('user-1');
    const receiver = await connectClient('user-2');
    messageService.sendMessage.mockResolvedValue(message);

    receiver.emit('join_room', { roomId: 'room-1' });
    await waitForExpect(() => {
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
    await waitForExpect(() => {
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
    await waitForExpect(() => {
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
  });

  it('recalls messages and emits message_recalled', async () => {
    const sender = await connectClient('user-1');
    const receiver = await connectClient('user-2');
    messageRepository.findById.mockResolvedValue(message);
    messageService.recallMessage.mockResolvedValue({ ...message, isRecalled: true });

    receiver.emit('join_room', { roomId: 'room-1' });
    await waitForExpect(() => {
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
    await waitForExpect(() => {
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
