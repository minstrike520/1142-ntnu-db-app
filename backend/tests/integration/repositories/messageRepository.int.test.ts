import { describe, it, expect, beforeEach } from 'bun:test';
import { MessageRepository } from '../../../src/repositories/messageRepository';
import { testPool } from '../../helpers/testPool';
import { resetDb } from '../../helpers/resetDb';

describe('MessageRepository (pg)', () => {
  const repo = new MessageRepository(testPool);

  beforeEach(async () => {
    await resetDb();
  });

  async function createUser(email: string) {
    const res = await testPool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id',
      ['Message Tester', email, 'hash'],
    );
    return res.rows[0].user_id as string;
  }

  async function createRoom() {
    const res = await testPool.query(
      'INSERT INTO chat_rooms (type, name) VALUES ($1, $2) RETURNING room_id',
      ['group', 'Message Repo Room'],
    );
    return res.rows[0].room_id as string;
  }

  it('create -> findById -> findByRoom returns camelCase messages in reverse-chronological order', async () => {
    const userId = await createUser('message-user@test.com');
    const roomId = await createRoom();

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
    const roomId = await createRoom();

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
    const roomId = await createRoom();

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

  it('create binds unassigned attachments once and returns attachment objects', async () => {
    const senderId = await createUser('attachment-sender@test.com');
    const roomId = await createRoom();
    const attachmentRes = await testPool.query(
      `INSERT INTO attachments (uploaded_by, file_path, file_type, original_name)
       VALUES ($1, $2, $3, $4)
       RETURNING attachment_id`,
      [senderId, 'uploads/test.txt', 'text/plain', 'test.txt'],
    );
    const attachmentId = attachmentRes.rows[0].attachment_id as string;

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
    const roomId = await createRoom();

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
    const roomId = await createRoom();
    const attachmentRes = await testPool.query(
      `INSERT INTO attachments (uploaded_by, file_path, file_type, original_name)
       VALUES ($1, $2, $3, $4)
       RETURNING attachment_id`,
      [senderId, 'uploads/recall-test.txt', 'text/plain', 'recall-test.txt'],
    );
    const attachmentId = attachmentRes.rows[0].attachment_id as string;

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
