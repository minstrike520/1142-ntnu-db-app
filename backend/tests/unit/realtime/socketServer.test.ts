import { describe, it, expect, beforeEach, afterAll, mock, type Mock } from 'bun:test';
import { ForbiddenError, NotFoundError } from '../../../src/utils/AppError';
import { attachSockets } from '../../../src/realtime/socketServer';
import type { ChatServer } from '../../../src/realtime/authSocket';
import type { MessageWithSender } from '../../../../shared/types';
import { trackUserConnection, trackUserDisconnection } from '../../../src/realtime/presence';

mock.module('../../../src/realtime/presence', () => ({
  trackUserConnection: mock().mockResolvedValue(undefined),
  trackUserDisconnection: mock().mockResolvedValue(undefined),
}));

afterAll(() => {
  mock.module('../../../src/realtime/presence', () => require('../../../src/realtime/presence?original'));
});

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
  let roomEmit: Mock<any>;
  let service: {
    sendMessage: Mock<any>;
    recallMessage: Mock<any>;
  };
  let repo: { findById: Mock<any> };
  let roomMemberRepo: { update: Mock<any>; findMember: Mock<any> };

  beforeEach(() => {
    handlers = {};
    roomEmit = mock();
    socket = {
      data: { user: { userId: 'user-1', name: 'Alice' } },
      join: mock(),
      leave: mock(),
      emit: mock(),
      to: mock(() => ({ emit: roomEmit })),
      on: mock((event, handler) => {
        handlers[event] = handler;
      }),
    };
    service = {
      sendMessage: mock(),
      recallMessage: mock(),
    };
    repo = { findById: mock() };
    roomMemberRepo = { update: mock(), findMember: mock() };

    const io = {
      on: mock((event, handler) => {
        if (event === 'connection') connectionHandler = handler;
      }),
      to: mock(() => ({ emit: roomEmit })),
    } as unknown as ChatServer;

    attachSockets(io, { messageService: service as any, messageRepository: repo, roomMemberRepository: roomMemberRepo });
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
    const socketRoomEmit = mock();
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
    const friendRepo = { getFriends: mock() };

    beforeEach(() => {
      ((trackUserConnection as any) as Mock<any>).mockClear();
      ((trackUserDisconnection as any) as Mock<any>).mockClear();

      frHandlers = {};
      frSocket = {
        id: 'socket-fr-1',
        data: { user: { userId: 'user-1', name: 'Alice' } },
        join: mock(),
        leave: mock(),
        emit: mock(),
        to: mock(() => ({ emit: mock() })),
        on: mock((event, handler) => { frHandlers[event] = handler; }),
      };

      let frConnectionHandler: any;
      const frIo = {
        on: mock((event, handler) => { if (event === 'connection') frConnectionHandler = handler; }),
        to: mock(() => ({ emit: mock() })),
      } as unknown as ChatServer;

      attachSockets(frIo, {
        messageService: service as any,
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
