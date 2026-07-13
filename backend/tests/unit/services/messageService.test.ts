import { describe, it, expect, vi, beforeEach, type Mocked } from 'vitest';
import { makeMessageService } from '../../../src/services/messageService';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../src/errors/AppError';
import type { IMessageRepository } from '../../../src/repositories/IMessageRepository';
import type { IRoomMemberRepository } from '../../../src/repositories/IRoomMemberRepository';
import type { IRoomRepository } from '../../../src/repositories/IRoomRepository';
import type { Message, MessageWithSender, Room, RoomMember } from '../../../../shared/types';

describe('messageService', () => {
  let messageRepo: Mocked<IMessageRepository>;
  let roomRepo: Mocked<IRoomRepository>;
  let roomMemberRepo: Mocked<IRoomMemberRepository>;
  let messageService: ReturnType<typeof makeMessageService>;

  const room: Room = {
    roomId: 'room-1',
    type: 'group',
    name: 'Study Room',
    requireApproval: false,
    viewHistory: true,
    isArchived: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const member: RoomMember = {
    roomId: 'room-1',
    userId: 'user-1',
    role: 'member',
    isMuted: false,
    joinTime: new Date('2026-01-01T00:00:00.000Z'),
  };

  const message: Message = {
    messageId: 'message-1',
    roomId: 'room-1',
    senderId: 'user-1',
    content: 'hello',
    isRecalled: false,
    sentAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const messageWithSender: MessageWithSender = {
    ...message,
    sender: {
      userId: 'user-1',
      name: 'Sender',
      avatarUrl: undefined,
    },
  };

  beforeEach(() => {
    messageRepo = {
      findById: vi.fn(),
      findByRoom: vi.fn(),
      create: vi.fn(),
      markRecalled: vi.fn(),
    };
    roomRepo = {
      findById: vi.fn(),
      findByInviteCode: vi.fn(),
      findByMember: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    roomMemberRepo = {
      findMember: vi.fn(),
      findByRoom: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      resolveMentions: vi.fn(),
    };
    messageService = makeMessageService(messageRepo, roomRepo, roomMemberRepo);
  });

  it('sendMessage validates, checks room membership, and creates a message', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue(member);
    messageRepo.create.mockResolvedValue(messageWithSender);

    const result = await messageService.sendMessage('user-1', 'room-1', '  hello  ');

    expect(roomRepo.findById).toHaveBeenCalledWith('room-1');
    expect(roomMemberRepo.findMember).toHaveBeenCalledWith('room-1', 'user-1');
    expect(messageRepo.create).toHaveBeenCalledWith({
      roomId: 'room-1',
      senderId: 'user-1',
      content: 'hello',
    });
    expect(result).toBe(messageWithSender);
  });

  it('sendMessage resolves unique @mentions and passes mentioned user ids to the repository', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue(member);
    roomMemberRepo.resolveMentions.mockResolvedValue(['user-2']);
    messageRepo.create.mockResolvedValue({ ...messageWithSender, content: 'hello @Bob @Bob', mentions: ['user-2'] });

    const result = await messageService.sendMessage('user-1', 'room-1', 'hello @Bob @Bob');

    expect(roomMemberRepo.resolveMentions).toHaveBeenCalledWith('room-1', ['Bob']);
    expect(messageRepo.create).toHaveBeenCalledWith({
      roomId: 'room-1',
      senderId: 'user-1',
      content: 'hello @Bob @Bob',
      mentions: ['user-2'],
    });
    expect(result.mentions).toEqual(['user-2']);
  });

  it('sendMessage expands @everyone to all other active room members', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue(member);
    roomMemberRepo.findByRoom.mockResolvedValue([
      member,
      { ...member, userId: 'user-2' },
      { ...member, userId: 'user-3' },
      { ...member, userId: 'user-4', role: 'pending' },
    ]);
    messageRepo.create.mockResolvedValue({
      ...messageWithSender,
      content: 'hello @everyone',
      mentions: ['user-2', 'user-3'],
    });

    const result = await messageService.sendMessage('user-1', 'room-1', 'hello @everyone');

    expect(roomMemberRepo.resolveMentions).not.toHaveBeenCalled();
    expect(roomMemberRepo.findByRoom).toHaveBeenCalledWith('room-1');
    expect(messageRepo.create).toHaveBeenCalledWith({
      roomId: 'room-1',
      senderId: 'user-1',
      content: 'hello @everyone',
      mentions: ['user-2', 'user-3'],
    });
    expect(result.mentions).toEqual(['user-2', 'user-3']);
  });

  it('sendMessage deduplicates @everyone and direct mentions', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue(member);
    roomMemberRepo.resolveMentions.mockResolvedValue(['user-2']);
    roomMemberRepo.findByRoom.mockResolvedValue([
      member,
      { ...member, userId: 'user-2' },
      { ...member, userId: 'user-3' },
    ]);
    messageRepo.create.mockResolvedValue({
      ...messageWithSender,
      content: 'hello @everyone @Bob',
      mentions: ['user-2', 'user-3'],
    });

    await messageService.sendMessage('user-1', 'room-1', 'hello @everyone @Bob');

    expect(roomMemberRepo.resolveMentions).toHaveBeenCalledWith('room-1', ['Bob']);
    expect(messageRepo.create).toHaveBeenCalledWith({
      roomId: 'room-1',
      senderId: 'user-1',
      content: 'hello @everyone @Bob',
      mentions: ['user-2', 'user-3'],
    });
  });

  it('sendMessage rejects empty content before touching repositories', async () => {
    await expect(messageService.sendMessage('user-1', 'room-1', '   ')).rejects.toThrow(ValidationError);
    expect(roomRepo.findById).not.toHaveBeenCalled();
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it('sendMessage throws NotFoundError when the room is missing', async () => {
    roomRepo.findById.mockResolvedValue(null);

    await expect(messageService.sendMessage('user-1', 'missing-room', 'hello')).rejects.toThrow(NotFoundError);
    expect(roomMemberRepo.findMember).not.toHaveBeenCalled();
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it('sendMessage throws ForbiddenError when caller is not a room member', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue(null);

    await expect(messageService.sendMessage('user-2', 'room-1', 'hello')).rejects.toThrow(ForbiddenError);
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it('listForRoom checks membership and returns chronological messages from the repository', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue(member);
    messageRepo.findByRoom.mockResolvedValue([messageWithSender]);

    const result = await messageService.listForRoom('user-1', 'room-1', {
      beforeId: 'message-0',
      limit: 10,
    });

    expect(messageRepo.findByRoom).toHaveBeenCalledWith('room-1', {
      beforeId: 'message-0',
      limit: 10,
      after: undefined,
    });
    expect(result).toEqual([messageWithSender]);
  });

  it('listForRoom rejects pending members', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue({ ...member, role: 'pending' });

    await expect(messageService.listForRoom('user-1', 'room-1')).rejects.toThrow(ForbiddenError);
    expect(messageRepo.findByRoom).not.toHaveBeenCalled();
  });

  it('sendMessage rejects muted members', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue({ ...member, isMuted: true });

    await expect(messageService.sendMessage('user-1', 'room-1', 'hello')).rejects.toThrow(ForbiddenError);
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it('sendMessage rejects read-only rooms', async () => {
    roomRepo.findById.mockResolvedValue({ ...room, isArchived: true });
    roomMemberRepo.findMember.mockResolvedValue(member);

    await expect(messageService.sendMessage('user-1', 'room-1', 'hello')).rejects.toThrow(ForbiddenError);
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it('sendMessage passes attachmentIds to the repository', async () => {
    const attachmentId = '550e8400-e29b-41d4-a716-446655440000';
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue(member);
    messageRepo.create.mockResolvedValue({
      ...messageWithSender,
      attachments: [{
        attachmentId,
        messageId: 'message-1',
        uploadedBy: 'user-1',
        fileUrl: `/api/v1/attachments/${attachmentId}`,
        fileType: 'text/plain',
        originalName: 'notes.txt',
        uploadedAt: new Date('2026-01-01T00:00:00.000Z'),
      }],
    });

    await messageService.sendMessage('user-1', 'room-1', 'hello', { attachmentIds: [attachmentId] });

    expect(messageRepo.create).toHaveBeenCalledWith({
      roomId: 'room-1',
      senderId: 'user-1',
      content: 'hello',
      attachmentIds: [attachmentId],
    });
  });

  it('sendMessage allows empty content when attachmentIds are provided', async () => {
    const attachmentId = '550e8400-e29b-41d4-a716-446655440000';
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue(member);
    messageRepo.create.mockResolvedValue({ ...messageWithSender, content: '' });

    await messageService.sendMessage('user-1', 'room-1', '', { attachmentIds: [attachmentId] });

    expect(messageRepo.create).toHaveBeenCalledWith({
      roomId: 'room-1',
      senderId: 'user-1',
      content: '',
      attachmentIds: [attachmentId],
    });
  });

  it('listForRoom applies join time when room history is hidden', async () => {
    const hiddenHistoryRoom = { ...room, viewHistory: false };
    roomRepo.findById.mockResolvedValue(hiddenHistoryRoom);
    roomMemberRepo.findMember.mockResolvedValue(member);
    messageRepo.findByRoom.mockResolvedValue([messageWithSender]);

    await messageService.listForRoom('user-1', 'room-1');

    expect(messageRepo.findByRoom).toHaveBeenCalledWith('room-1', {
      beforeId: undefined,
      limit: 50,
      after: member.joinTime,
    });
  });

  it('recallMessage checks membership and recalls messages that belong to the room', async () => {
    const recalled: MessageWithSender = { ...messageWithSender, isRecalled: true };
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue(member);
    messageRepo.findById.mockResolvedValue(message);
    messageRepo.markRecalled.mockResolvedValue(recalled);

    const result = await messageService.recallMessage('user-1', 'room-1', 'message-1');

    expect(messageRepo.markRecalled).toHaveBeenCalledWith('message-1');
    expect(result).toBe(recalled);
  });

  it('recallMessage hides messages outside the room behind NotFoundError', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue(member);
    messageRepo.findById.mockResolvedValue({ ...message, roomId: 'other-room' });

    await expect(messageService.recallMessage('user-1', 'room-1', 'message-1')).rejects.toThrow(NotFoundError);
    expect(messageRepo.markRecalled).not.toHaveBeenCalled();
  });

  it('recallMessage rejects callers who are not the original sender', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue(member);
    messageRepo.findById.mockResolvedValue({ ...message, senderId: 'user-2' });

    await expect(messageService.recallMessage('user-1', 'room-1', 'message-1')).rejects.toThrow(ForbiddenError);
    expect(messageRepo.markRecalled).not.toHaveBeenCalled();
  });

  it('sendMessage rejects isReadonly rooms', async () => {
    roomRepo.findById.mockResolvedValue({ ...room, isReadonly: true });
    roomMemberRepo.findMember.mockResolvedValue(member);

    await expect(messageService.sendMessage('user-1', 'room-1', 'hello')).rejects.toThrow(ForbiddenError);
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it('sendMessage includes replyToId when provided', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue(member);
    messageRepo.create.mockResolvedValue(messageWithSender);

    await messageService.sendMessage('user-1', 'room-1', 'reply', { replyToId: 'msg-0' });

    expect(messageRepo.create).toHaveBeenCalledWith(expect.objectContaining({ replyToId: 'msg-0' }));
  });

  it('recallMessage allows room owner to recall any message', async () => {
    const recalled: MessageWithSender = { ...messageWithSender, isRecalled: true };
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue({ ...member, role: 'owner' });
    messageRepo.findById.mockResolvedValue({ ...message, senderId: 'user-2' });
    messageRepo.markRecalled.mockResolvedValue(recalled);

    const result = await messageService.recallMessage('user-1', 'room-1', 'message-1');

    expect(messageRepo.markRecalled).toHaveBeenCalledWith('message-1');
    expect(result).toBe(recalled);
  });

  it('recallMessage allows room admin to recall member messages', async () => {
    const recalled: MessageWithSender = { ...messageWithSender, isRecalled: true };
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockImplementation(async (roomId, uid) => {
      if (uid === 'user-1') return { ...member, role: 'admin' };
      if (uid === 'user-2') return { ...member, role: 'member' };
      return null;
    });
    messageRepo.findById.mockResolvedValue({ ...message, senderId: 'user-2' });
    messageRepo.markRecalled.mockResolvedValue(recalled);

    const result = await messageService.recallMessage('user-1', 'room-1', 'message-1');

    expect(messageRepo.markRecalled).toHaveBeenCalledWith('message-1');
    expect(result).toBe(recalled);
  });

  it('recallMessage rejects admins who attempt to recall owner messages', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockImplementation(async (roomId, uid) => {
      if (uid === 'user-1') return { ...member, role: 'admin' };
      if (uid === 'user-2') return { ...member, role: 'owner' };
      return null;
    });
    messageRepo.findById.mockResolvedValue({ ...message, senderId: 'user-2' });

    await expect(messageService.recallMessage('user-1', 'room-1', 'message-1')).rejects.toThrow(ForbiddenError);
    expect(messageRepo.markRecalled).not.toHaveBeenCalled();
  });

  it('recallMessage rejects admins who attempt to recall other admin messages', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockImplementation(async (roomId, uid) => {
      if (uid === 'user-1') return { ...member, role: 'admin' };
      if (uid === 'user-2') return { ...member, role: 'admin' };
      return null;
    });
    messageRepo.findById.mockResolvedValue({ ...message, senderId: 'user-2' });

    await expect(messageService.recallMessage('user-1', 'room-1', 'message-1')).rejects.toThrow(ForbiddenError);
    expect(messageRepo.markRecalled).not.toHaveBeenCalled();
  });

  it('recallMessage throws NotFoundError when message does not exist', async () => {
    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockResolvedValue(member);
    messageRepo.findById.mockResolvedValue(null);

    await expect(messageService.recallMessage('user-1', 'room-1', 'missing')).rejects.toThrow(NotFoundError);
    expect(messageRepo.markRecalled).not.toHaveBeenCalled();
  });
});
