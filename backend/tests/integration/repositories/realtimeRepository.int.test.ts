import { beforeEach, describe, expect, test } from 'bun:test';
import { RealtimeRepository } from '../../../src/models/realtimeRepository';
import { resetDb } from '../../helpers/resetDb';
import { testPool } from '../../helpers/testPool';

describe('RealtimeRepository durable semantics', () => {
  const repo = new RealtimeRepository(testPool, { cursorSecret: 'cursor-test-secret' });
  let userId: string;
  let roomId: string;

  beforeEach(async () => {
    await resetDb();
    const users = await testPool`
      INSERT INTO users (name, email, password_hash)
      VALUES ('Alice', 'realtime-alice@test.com', 'hash')
      RETURNING user_id
    `;
    userId = users[0].user_id as string;
    const rooms = await testPool`
      INSERT INTO chat_rooms (type, name)
      VALUES ('group', 'Realtime Room')
      RETURNING room_id
    `;
    roomId = rooms[0].room_id as string;
    await testPool`
      INSERT INTO room_members (room_id, user_id, role)
      VALUES (${roomId}, ${userId}, 'owner')
    `;
  });

  test('message.send is idempotent and rejects command-id payload conflicts', async () => {
    const input = {
      userId,
      commandId: 'command-1',
      payloadHash: 'a'.repeat(64),
      roomId,
      content: 'hello',
    };
    const first = await repo.createMessage(input);
    const replay = await repo.createMessage(input);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.message.messageId).toBe(first.message.messageId);
    expect(replay.message.revision).toBe(first.message.revision);

    await expect(repo.createMessage({
      ...input,
      payloadHash: 'b'.repeat(64),
      content: 'different intent',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const rows = await testPool`SELECT COUNT(*)::int AS count FROM messages`;
    expect(rows[0].count).toBe(1);
    const memberships = await testPool`
      SELECT last_read_id FROM room_members WHERE room_id = ${roomId} AND user_id = ${userId}
    `;
    expect(memberships[0].last_read_id).toBe(first.message.messageId);
  });

  test('revision conflicts are rejected and delta windows keep a fixed high-water', async () => {
    const first = await repo.createMessage({
      userId,
      commandId: 'command-1',
      payloadHash: '1'.repeat(64),
      roomId,
      content: 'one',
    });
    const edited = await repo.editMessage({
      userId,
      roomId,
      commandId: 'edit-command-1',
      payloadHash: 'e'.repeat(64),
      messageId: first.message.messageId,
      expectedRevision: first.message.revision,
      content: 'one edited',
    });
    await expect(repo.editMessage({
      userId,
      roomId,
      commandId: 'edit-command-2',
      payloadHash: 'f'.repeat(64),
      messageId: first.message.messageId,
      expectedRevision: first.message.revision,
      content: 'stale edit',
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const pageOne = await repo.getMessageDelta(userId, { limit: 1 });
    expect(pageOne.complete).toBe(false);
    const later = await repo.createMessage({
      userId,
      commandId: 'command-2',
      payloadHash: '2'.repeat(64),
      roomId,
      content: 'created during recovery',
    });
    const pageTwo = await repo.getMessageDelta(userId, { cursor: pageOne.cursor, limit: 10 });
    expect(pageTwo.complete).toBe(true);
    expect(pageTwo.changes.map((change) => change.revision)).not.toContain(later.message.revision);
    expect(BigInt(pageTwo.highWaterRevision)).toBe(BigInt(edited.message.revision));

    const nextWindow = await repo.getMessageDelta(userId, { cursor: pageTwo.cursor, limit: 10 });
    expect(nextWindow.changes.map((change) => change.revision)).toContain(later.message.revision);

    await testPool`
      UPDATE room_members SET role = 'pending'
      WHERE room_id = ${roomId} AND user_id = ${userId}
    `;
    await expect(repo.getMessageDelta(userId, { cursor: nextWindow.cursor })).rejects.toMatchObject({
      code: 'CURSOR_INVALID',
    });
  });

  test('message.delta restores attachments and mentions needed for convergence', async () => {
    const mentionedUsers = await testPool`
      INSERT INTO users (name, email, password_hash)
      VALUES ('Bob', 'realtime-bob@test.com', 'hash')
      RETURNING user_id
    `;
    const mentionedUserId = mentionedUsers[0].user_id as string;
    await testPool`
      INSERT INTO room_members (room_id, user_id, role)
      VALUES (${roomId}, ${mentionedUserId}, 'member')
    `;
    const attachments = await testPool`
      INSERT INTO attachments (uploaded_by, file_path, file_type, original_name)
      VALUES (${userId}, '/tmp/realtime-file', 'text/plain', 'notes.txt')
      RETURNING attachment_id
    `;
    const attachmentId = attachments[0].attachment_id as string;

    const created = await repo.createMessage({
      userId,
      commandId: 'attachment-command',
      payloadHash: 'a'.repeat(64),
      roomId,
      content: '@Bob',
      attachmentIds: [attachmentId],
      mentionIds: [mentionedUserId],
    });
    const delta = await repo.getMessageDelta(userId);
    const change = delta.changes.find((item) => item.message.messageId === created.message.messageId);

    expect(change?.message.mentions).toEqual([mentionedUserId]);
    expect(change?.message.attachments).toEqual([
      expect.objectContaining({ attachmentId, originalName: 'notes.txt' }),
    ]);
  });

  test('message.edit replay returns its committed revision and rejects changed intent', async () => {
    const first = await repo.createMessage({
      userId,
      commandId: 'send-command-1',
      payloadHash: '1'.repeat(64),
      roomId,
      content: 'one',
    });
    const edit = {
      userId,
      roomId,
      commandId: 'edit-command-1',
      payloadHash: '2'.repeat(64),
      messageId: first.message.messageId,
      expectedRevision: first.message.revision,
      content: 'edited once',
    };

    const committed = await repo.editMessage(edit);
    const replay = await repo.editMessage(edit);
    expect(committed.replayed).toBe(false);
    expect(replay).toEqual({ ...committed, replayed: true });
    await expect(repo.editMessage({
      ...edit,
      payloadHash: '3'.repeat(64),
      content: 'different intent',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const changes = await testPool`
      SELECT COUNT(*)::int AS count FROM message_changes
      WHERE message_id = ${first.message.messageId} AND change_type = 'updated'
    `;
    expect(changes[0].count).toBe(1);
  });

  test('message mutations cannot cross the room supplied by the command', async () => {
    const first = await repo.createMessage({
      userId,
      commandId: 'command-1',
      payloadHash: '1'.repeat(64),
      roomId,
      content: 'one',
    });
    const otherRooms = await testPool`
      INSERT INTO chat_rooms (type, name) VALUES ('group', 'Other Room') RETURNING room_id
    `;
    const otherRoomId = otherRooms[0].room_id as string;
    await testPool`
      INSERT INTO room_members (room_id, user_id, role) VALUES (${otherRoomId}, ${userId}, 'owner')
    `;

    await expect(repo.editMessage({
      userId,
      roomId: otherRoomId,
      commandId: 'edit-command-1',
      payloadHash: '2'.repeat(64),
      messageId: first.message.messageId,
      expectedRevision: first.message.revision,
      content: 'cross-room edit',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(repo.recallMessage({
      userId,
      roomId: otherRoomId,
      commandId: 'recall-command-1',
      payloadHash: '3'.repeat(64),
      messageId: first.message.messageId,
      actorRole: 'owner',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('Read position only advances in canonical message order', async () => {
    const senders = await testPool`
      INSERT INTO users (name, email, password_hash)
      VALUES ('Bob', 'read-position-bob@test.com', 'hash')
      RETURNING user_id
    `;
    const senderId = senders[0].user_id as string;
    await testPool`
      INSERT INTO room_members (room_id, user_id, role)
      VALUES (${roomId}, ${senderId}, 'member')
    `;
    const first = await repo.createMessage({
      userId: senderId,
      commandId: 'command-1',
      payloadHash: '1'.repeat(64),
      roomId,
      content: 'one',
    });
    const second = await repo.createMessage({
      userId: senderId,
      commandId: 'command-2',
      payloadHash: '2'.repeat(64),
      roomId,
      content: 'two',
    });

    expect(await repo.advanceReadPosition(userId, roomId, second.message.messageId)).toEqual({
      messageId: second.message.messageId,
      advanced: true,
    });
    expect(await repo.advanceReadPosition(userId, roomId, first.message.messageId)).toEqual({
      messageId: second.message.messageId,
      advanced: false,
    });
  });

  test('emergency notifications are acknowledged per recipient and not replayed', async () => {
    const first = await repo.createEmergencyNotification({
      sourceUserId: userId,
      recipientId: userId,
      idempotencyKey: 'alert-1',
      message: 'first alert',
    });
    const second = await repo.createEmergencyNotification({
      sourceUserId: userId,
      recipientId: userId,
      idempotencyKey: 'alert-2',
      message: 'second alert',
    });

    expect((await repo.listEmergencyNotifications(userId)).map((item) => item.notificationId))
      .toEqual([second.notificationId, first.notificationId]);

    await repo.acknowledgeEmergencyNotification(userId, first.notificationId);
    expect((await repo.listEmergencyNotifications(userId)).map((item) => item.notificationId))
      .toEqual([second.notificationId]);
    await repo.acknowledgeEmergencyNotification(userId, first.notificationId);
    expect((await repo.listEmergencyNotifications(userId)).map((item) => item.notificationId))
      .toEqual([second.notificationId]);
  });
});
