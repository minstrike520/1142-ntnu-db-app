import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { MessageRepository } from '../../../src/models/messageRepository';
import { testPool } from '../../helpers/testPool';
import { resetDb } from '../../helpers/resetDb';

describe('MessageRepository (pg)', () => {
  const repo = new MessageRepository(testPool);

  beforeEach(async () => {
    await resetDb();
  });

  async function createUser(email: string) {
    const res = await testPool`
      INSERT INTO users (name, email, password_hash) VALUES ('Message Tester', ${email}, 'hash') RETURNING user_id
    `;
    return res[0].user_id as string;
  }

  async function createRoom(userId?: string) {
    const res = await testPool`
      INSERT INTO chat_rooms (type, name) VALUES ('group', 'Message Repo Room') RETURNING room_id
    `;
    const roomId = res[0].room_id as string;
    if (userId) {
      await testPool`
        INSERT INTO room_members (room_id, user_id, role)
        VALUES (${roomId}, ${userId}, 'owner')
      `;
    }
    return roomId;
  }

  it('create -> findById -> findByRoom returns camelCase messages in reverse-chronological order', async () => {
    const userId = await createUser('message-user@test.com');
    const roomId = await createRoom(userId);

    const first = await repo.create({
      roomId,
      senderId: userId,
      content: 'first message',
    });
    const second = await repo.create({
      roomId,
      senderId: userId,
      content: 'second message',
      replyToId: first.messageId,
    });

    expect(first.messageId).toBeDefined();
    expect(first.roomId).toBe(roomId);
    expect(first.senderId).toBe(userId);
    expect(first.sender).toEqual({
      userId,
      name: 'Message Tester',
      avatarUrl: undefined,
    });
    expect(first.replyToId).toBeUndefined();
    expect(first.isRecalled).toBe(false);
    expect(first.sentAt).toBeInstanceOf(Date);

    const fetched = await repo.findById(second.messageId);
    expect(fetched).toMatchObject({
      messageId: second.messageId,
      roomId,
      senderId: userId,
      content: 'second message',
    });
    expect(fetched?.replyToId).toBe(first.messageId);

    const messages = await repo.findByRoom(roomId, { limit: 10 });
    expect(messages.map((message) => message.messageId)).toEqual([
      second.messageId,
      first.messageId,
    ]);
    expect(messages[0].sender).toEqual({
      userId,
      name: 'Message Tester',
      avatarUrl: undefined,
    });
  });

  it('findByRoom respects beforeId and limit', async () => {
    const userId = await createUser('pagination-user@test.com');
    const roomId = await createRoom(userId);

    const first = await repo.create({ roomId, senderId: userId, content: 'one' });
    const second = await repo.create({ roomId, senderId: userId, content: 'two' });
    await repo.create({ roomId, senderId: userId, content: 'three' });

    const beforeSecond = await repo.findByRoom(roomId, {
      beforeId: second.messageId,
      limit: 5,
    });
    expect(beforeSecond.map((message) => message.messageId)).toEqual([first.messageId]);

    const limited = await repo.findByRoom(roomId, { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].content).toBe('three');
    expect(limited[1].content).toBe('two');
  });

  it('create stores mentions and reads them back with messages', async () => {
    const senderId = await createUser('mention-sender@test.com');
    const mentionedId = await createUser('mentioned-user@test.com');
    const roomId = await createRoom(senderId);

    const created = await repo.create({
      roomId,
      senderId,
      content: 'hello @Message Tester',
      mentions: [mentionedId],
    });

    expect(created.mentions).toEqual([mentionedId]);

    const messages = await repo.findByRoom(roomId, { limit: 10 });
    expect(messages[0].mentions).toEqual([mentionedId]);
  });

  it('sync keeps relation snapshots attached to their message revision', async () => {
    const senderId = await createUser('snapshot-sender@test.com');
    const mentionedId = await createUser('snapshot-mentioned@test.com');
    const roomId = await createRoom(senderId);

    const created = await repo.create({
      roomId,
      senderId,
      content: 'hello @Message Tester',
      mentions: [mentionedId],
    });
    await repo.update(created.messageId, 'edited without a mention', [], 1, 'snapshot-edit-1', senderId);

    const changes = await repo.findChangesForUser(senderId, 0, 10);
    expect(changes).toHaveLength(2);
    expect(changes[0].message.content).toBe('hello @Message Tester');
    expect(changes[0].message.mentions).toEqual([mentionedId]);
    expect(changes[1].message.content).toBe('edited without a mention');
    expect(changes[1].message.mentions).toEqual([]);
  });

  it('create binds unassigned attachments once and returns attachment objects', async () => {
    const senderId = await createUser('attachment-sender@test.com');
    const roomId = await createRoom(senderId);
    const filePath = 'uploads/test.txt';
    const fileType = 'text/plain';
    const originalName = 'test.txt';
    const attachmentRes = await testPool`
      INSERT INTO attachments (uploaded_by, file_path, file_type, original_name)
      VALUES (${senderId}, ${filePath}, ${fileType}, ${originalName})
      RETURNING attachment_id
    `;
    const attachmentId = attachmentRes[0].attachment_id as string;

    const created = await repo.create({
      roomId,
      senderId,
      content: 'message with attachment',
      attachmentIds: [attachmentId],
    });

    expect(created.attachments).toEqual([
      expect.objectContaining({
        attachmentId,
        messageId: created.messageId,
        uploadedBy: senderId,
        fileUrl: `/api/v1/attachments/${attachmentId}`,
        fileType: 'text/plain',
        originalName: 'test.txt',
      }),
    ]);

    const messages = await repo.findByRoom(roomId, { limit: 10 });
    expect(messages[0].attachments).toEqual([
      expect.objectContaining({
        attachmentId,
        messageId: created.messageId,
        originalName: 'test.txt',
      }),
    ]);

    await expect(repo.create({
      roomId,
      senderId,
      content: 'try reusing attachment',
      attachmentIds: [attachmentId],
    })).rejects.toThrow('Attachments must exist and must not already belong to a message');
  });

  it('markRecalled sets isRecalled and findById returns null for missing messages', async () => {
    const userId = await createUser('recall-user@test.com');
    const roomId = await createRoom(userId);

    const message = await repo.create({ roomId, senderId: userId, content: 'recall me' });
    const recalled = await repo.markRecalled(message.messageId);

    expect(recalled.messageId).toBe(message.messageId);
    expect(recalled.isRecalled).toBe(true);
    expect(recalled.sender).toEqual({
      userId,
      name: 'Message Tester',
      avatarUrl: undefined,
    });
    await expect(repo.markRecalled('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      'Message not found',
    );

    const missing = await repo.findById('00000000-0000-0000-0000-000000000000');
    expect(missing).toBeNull();
  });

  it('markRecalled hides attachments from the recalled message and future fetches', async () => {
    const senderId = await createUser('recall-attachment-sender@test.com');
    const roomId = await createRoom(senderId);
    const filePath = 'uploads/recall-test.txt';
    const fileType = 'text/plain';
    const originalName = 'recall-test.txt';
    const attachmentRes = await testPool`
      INSERT INTO attachments (uploaded_by, file_path, file_type, original_name)
      VALUES (${senderId}, ${filePath}, ${fileType}, ${originalName})
      RETURNING attachment_id
    `;
    const attachmentId = attachmentRes[0].attachment_id as string;

    const created = await repo.create({
      roomId,
      senderId,
      content: 'recall me with an attachment',
      attachmentIds: [attachmentId],
    });
    expect(created.attachments).toHaveLength(1);

    const recalled = await repo.markRecalled(created.messageId);
    expect(recalled.isRecalled).toBe(true);
    expect(recalled.attachments).toBeUndefined();

    const messages = await repo.findByRoom(roomId, { limit: 10 });
    expect(messages[0].isRecalled).toBe(true);
    expect(messages[0].attachments).toBeUndefined();
  });
});
