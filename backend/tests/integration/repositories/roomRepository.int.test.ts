import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { RoomRepository } from '../../../src/repositories/roomRepository';
import { testPool } from '../../helpers/testPool';
import { resetDb } from '../../helpers/resetDb';

describe('RoomRepository (pg)', () => {
  const repo = new RoomRepository(testPool);

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await testPool.end();
  });

  it('create → findById → findByMember → update → delete', async () => {
    // create a user so we can add a room member
    const userRes = await testPool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ('Alice', 'alice@test.com', 'hash') RETURNING user_id"
    );
    const userId: string = userRes.rows[0].user_id;

    // create
    const room = await repo.create({
      type: 'group',
      name: 'Study Room',
      requireApproval: false,
      viewHistory: true,
    });

    expect(typeof room.roomId).toBe('string');
    expect(room.type).toBe('group');
    expect(room.name).toBe('Study Room');
    expect(room.requireApproval).toBe(false);
    expect(room.viewHistory).toBe(true);
    expect(room.isArchived).toBe(false);
    expect(room.createdAt).toBeInstanceOf(Date);

    // findById
    const fetched = await repo.findById(room.roomId);
    expect(fetched).toEqual(room);

    // findByMember — add membership first, then verify room appears
    await testPool.query(
      'INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)',
      [room.roomId, userId, 'owner']
    );
    const rooms = await repo.findByMember(userId);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].roomId).toBe(room.roomId);

    // update
    const updated = await repo.update(room.roomId, {
      name: 'Updated Room',
      isArchived: true,
    });
    expect(updated.name).toBe('Updated Room');
    expect(updated.isArchived).toBe(true);
    expect(updated.roomId).toBe(room.roomId);

    const afterUpdate = await repo.findById(room.roomId);
    expect(afterUpdate).toEqual(updated);

    // delete
    await repo.delete(room.roomId);
    const afterDelete = await repo.findById(room.roomId);
    expect(afterDelete).toBeNull();
  });

  it('findById returns null for non-existent room', async () => {
    const result = await repo.findById('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('findByMember returns empty array when user has no rooms', async () => {
    const userRes = await testPool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ('Bob', 'bob@test.com', 'hash') RETURNING user_id"
    );
    const result = await repo.findByMember(userRes.rows[0].user_id);
    expect(result).toEqual([]);
  });

  it('create accepts type="private"', async () => {
    const room = await repo.create({
      type: 'private',
      name: undefined,
      requireApproval: false,
      viewHistory: false,
    });
    expect(room.type).toBe('private');
    expect(typeof room.roomId).toBe('string');
  });

  it('findByMember unreadCount logic: unread count correctly reflects read status', async () => {
    const user1Res = await testPool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ('Alice', 'alice@test.com', 'hash') RETURNING user_id"
    );
    const user2Res = await testPool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ('Bob', 'bob@test.com', 'hash') RETURNING user_id"
    );
    const aliceId = user1Res.rows[0].user_id;
    const bobId = user2Res.rows[0].user_id;

    const room = await repo.create({
      type: 'group',
      name: 'Group Chat',
      requireApproval: false,
      viewHistory: true,
    });

    await testPool.query(
      'INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $5)',
      [room.roomId, aliceId, 'owner', bobId, 'member']
    );

    // 1. Bob sends a message, Alice's last_read_id is NULL (unread count should be 1)
    const msg1Res = await testPool.query(
      'INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, $3) RETURNING message_id',
      [room.roomId, bobId, 'Hello from Bob']
    );
    const msg1Id = msg1Res.rows[0].message_id;

    let rooms = await repo.findByMember(aliceId);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].unreadCount).toBe(1);

    // 2. Alice updates last_read_id to Bob's message (unread count should be 0)
    await testPool.query(
      'UPDATE room_members SET last_read_id = $1 WHERE room_id = $2 AND user_id = $3',
      [msg1Id, room.roomId, aliceId]
    );
    rooms = await repo.findByMember(aliceId);
    expect(rooms[0].unreadCount).toBe(0);

    // 3. Alice sends a message, and updates her last_read_id to her own message (unread count should be 0)
    const msg2Res = await testPool.query(
      'INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, $3) RETURNING message_id',
      [room.roomId, aliceId, 'Hello from Alice']
    );
    const msg2Id = msg2Res.rows[0].message_id;

    await testPool.query(
      'UPDATE room_members SET last_read_id = $1 WHERE room_id = $2 AND user_id = $3',
      [msg2Id, room.roomId, aliceId]
    );
    rooms = await repo.findByMember(aliceId);
    expect(rooms[0].unreadCount).toBe(0);
  });
});
